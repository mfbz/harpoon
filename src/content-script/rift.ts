import {
  ERROR_CODES,
  RIFT_URI_SCHEME,
  RiftContextMessage,
  RiftErrorMessage,
  RiftHandshakeMessage,
  RiftIntentMessage,
  wallet,
  setConfig,
} from 'rift-js';
import storage from '../shared/utils/storage';

// Track which Rift URLs have already been processed to avoid duplicate prompts
const processedRiftUrls = new Map<string, boolean>();

// Track if a prompt is currently being shown to prevent multiple prompts
let isPromptActive = false;

// Generate a unique message ID
function generateMessageId() {
  return `rift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Store message callbacks for handling responses from background
const messageCallbacks = new Map<string, (response: any) => void>();

// Helper function to send messages to background and handle responses
function sendMessageToBackground(message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const messageId = generateMessageId();
    const messageWithId = { ...message, messageId };

    // Store callback for when response comes back
    messageCallbacks.set(messageId, (response) => {
      console.log(`Received response for message ${messageId}:`, response);
      if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });

    // Send message to background
    console.log(`Sending message to background with ID ${messageId}:`, messageWithId);
    chrome.runtime.sendMessage(messageWithId, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending message:', chrome.runtime.lastError);
        messageCallbacks.delete(messageId);
        reject(new Error(chrome.runtime.lastError.message));
      }
      // Note: response handling happens in the message listener below
    });
  });
}

// Set up global message listener for responses from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.responseId && messageCallbacks.has(message.responseId)) {
    const callback = messageCallbacks.get(message.responseId);
    if (callback) {
      callback(message.data);
      messageCallbacks.delete(message.responseId);
    }
    return true;
  }
});

// Check if Rift Frames are enabled in settings
async function isRiftFramesEnabled(): Promise<boolean> {
  const riftEnabled = await storage.get('riftFramesEnabled');
  return riftEnabled === true;
}

// Check if HTTP development mode is enabled in settings
async function isHttpDevelopmentModeEnabled(): Promise<boolean> {
  const httpDevMode = await storage.get('riftHttpDevelopmentMode');
  return httpDevMode === true;
}

// Check if user has already approved this domain
async function isDomainApproved(domain: string): Promise<boolean> {
  const approvedDomains = (await storage.get('riftApprovedDomains')) || [];
  return approvedDomains.includes(domain);
}

// Save approved domain to storage
async function approveDomain(domain: string): Promise<void> {
  const approvedDomains = (await storage.get('riftApprovedDomains')) || [];
  if (!approvedDomains.includes(domain)) {
    approvedDomains.push(domain);
    await storage.set('riftApprovedDomains', approvedDomains);
  }
}

// Convert a rift:// URL to http:// or https:// based on development mode settings
function convertRiftUrl(riftUrl: string, useHttp: boolean = false): string {
  const protocol = useHttp ? 'http://' : 'https://';

  // Replace the rift:// scheme with the appropriate protocol
  return riftUrl.replace(RIFT_URI_SCHEME, protocol);
}

// Ask user for permission to inject Rift frame
function promptForRiftInjection(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Prevent multiple prompts from being shown simultaneously
    if (isPromptActive) {
      console.warn('A Rift injection prompt is already active');
      resolve(false);
      return;
    }

    isPromptActive = true;

    // Create prompt UI
    const promptDiv = document.createElement('div');
    promptDiv.style.position = 'fixed';
    promptDiv.style.bottom = '24px';
    promptDiv.style.right = '24px';
    promptDiv.style.backgroundColor = '#1E1E1E';
    promptDiv.style.borderRadius = '12px';
    promptDiv.style.padding = '16px';
    promptDiv.style.zIndex = '9999';
    promptDiv.style.color = 'white';
    promptDiv.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';

    promptDiv.innerHTML = `
      <div style="margin-bottom: 12px; font-weight: 600;">
        🪝 Harpoon detected a 🌀 Rift from ${domain}
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="rift-deny" style="background: none; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 8px 12px; color: white; cursor: pointer;">
          Deny
        </button>
        <button id="rift-approve" style="background: #00B4D8; border: none; border-radius: 8px; padding: 8px 12px; color: white; font-weight: 500; cursor: pointer;">
          Inject it
        </button>
      </div>
    `;

    document.body.appendChild(promptDiv);

    // Function to clean up and resolve
    const finishPrompt = (approved: boolean) => {
      promptDiv.remove();
      isPromptActive = false;
      resolve(approved);
    };

    // Add event listeners
    document.getElementById('rift-deny')?.addEventListener('click', () => {
      finishPrompt(false);
    });

    document.getElementById('rift-approve')?.addEventListener('click', () => {
      finishPrompt(true);
    });
  });
}

// Main function to detect and inject Rift frames
export async function initRiftDetection(): Promise<void> {
  // Only proceed if Rift frames are enabled
  const enabled = await isRiftFramesEnabled();
  if (!enabled) {
    return;
  }

  // Check if HTTP development mode is enabled
  const httpDevMode = await isHttpDevelopmentModeEnabled();
  console.log('httpDevMode', httpDevMode);

  // Configure rift-js to use HTTP for local development if enabled
  if (httpDevMode) {
    // Use the setConfig function to configure HTTP for local development
    setConfig({
      useHttpForLocalDevelopment: true,
    });
  } else {
    // Reset to default behavior (HTTPS only)
    setConfig({
      useHttpForLocalDevelopment: false,
    });
  }

  // Create a detector from rift-js
  const detector = new wallet.detector.RiftDetector({
    onRiftLinkFound: async (linkElement, riftUrl) => {
      try {
        // Skip if this URL has already been processed
        if (processedRiftUrls.has(riftUrl)) {
          return;
        }

        // Mark this URL as being processed
        processedRiftUrls.set(riftUrl, true);

        // Convert the rift URL to HTTPS (or HTTP for localhost when dev mode is on)
        const convertedUrl = convertRiftUrl(riftUrl, httpDevMode);
        console.log('convertedUrl', convertedUrl);

        // Parse domain from the URL
        const url = new URL(convertedUrl);
        const domain = url.hostname;

        // Check if domain is already approved
        const approved = await isDomainApproved(domain);
        if (!approved) {
          // Prompt user for approval
          const userApproved = await promptForRiftInjection(domain);
          if (!userApproved) {
            // If not approved, remove from processed list to allow future prompts
            processedRiftUrls.delete(riftUrl);
            return;
          }

          // Save domain approval
          await approveDomain(domain);
        }

        // Use the iframe injector from rift-js
        const injector = new wallet.injector.IframeInjector({
          onIframeInjected: (iframe) => {
            // Set up message handler for this iframe
            setupFrameMessageHandling(iframe);
          },
        });

        // Inject the iframe, injector will set correct url based on config
        injector.injectFrame(linkElement, riftUrl);
      } catch (error) {
        // Clean up in case of error
        processedRiftUrls.delete(riftUrl);
        console.error('Error injecting Rift frame:', error);
      }
    },
  });

  // Start detection
  detector.start();
}

// Setup window.postMessage communication with the iframe
function setupFrameMessageHandling(iframe: HTMLIFrameElement): void {
  // Create a handler for iframe messages
  const messageHandler = async (event: MessageEvent) => {
    // Skip messages not from this iframe
    if (event.source !== iframe.contentWindow) {
      return;
    }

    // Only handle messages with rift: type
    if (!event.data || !event.data.type || !event.data.type.startsWith('rift:')) {
      return;
    }

    // Process message types
    switch (event.data.type) {
      case 'rift:handshake':
        handleHandshake(iframe, event.data as RiftHandshakeMessage);
        break;
      case 'rift:intent':
        handleIntent(iframe, event.data as RiftIntentMessage);
        break;
      default:
        console.warn('Unknown Rift message type:', event.data.type);
    }
  };

  // Add listener
  window.addEventListener('message', messageHandler);

  // Store the handler on the iframe to be able to clean up later
  (iframe as any)._riftMessageHandler = messageHandler;
}

// Handle handshake messages
async function handleHandshake(
  iframe: HTMLIFrameElement,
  message: RiftHandshakeMessage
): Promise<void> {
  try {
    // Access message safely - log the entire message
    console.log('Handling Rift handshake request:', message);

    // Create a flag to track if we've already responded
    let hasResponded = false;

    // Setup a fallback timeout in case background script doesn't respond
    const timeoutId = setTimeout(() => {
      if (!hasResponded) {
        console.warn('Handshake response timed out, sending fallback error');
        hasResponded = true;

        // Send error as fallback when background doesn't respond
        const errorMessage: RiftErrorMessage = {
          type: 'rift:error',
          code: ERROR_CODES.WALLET_UNAVAILABLE,
          message: 'Wallet connection timed out',
        };

        iframe.contentWindow?.postMessage(errorMessage, '*');
      }
    }, 5000); // 5 second timeout (increased from 3)

    try {
      // Request wallet information from background script using new helper
      const response = await sendMessageToBackground({ type: 'RIFT:GET_CONTEXT' });

      // Clear the timeout since we got a response
      clearTimeout(timeoutId);

      // Check if we've already responded from the timeout
      if (hasResponded) {
        console.log('Received late response from background, but already sent fallback');
        return;
      }

      // Mark that we've responded
      hasResponded = true;

      console.log('Received response from background:', response);

      // Enhanced validation to handle potentially malformed responses
      const hasValidAddress =
        response && typeof response.address === 'string' && response.address.length > 0;

      const hasValidNetwork =
        response && typeof response.network === 'string' && response.network.length > 0;

      console.log('Response validation:', {
        hasValidAddress,
        hasValidNetwork,
        addressType: response?.address ? typeof response.address : 'undefined',
        networkType: response?.network ? typeof response.network : 'undefined',
        responseType: typeof response,
      });

      if (hasValidAddress && hasValidNetwork) {
        // Send wallet context back to iframe
        const contextMessage: RiftContextMessage = {
          type: 'rift:context',
          address: response.address,
          network: response.network,
        };

        console.log('Sending context back to iframe:', contextMessage);
        iframe.contentWindow?.postMessage(contextMessage, '*');
      } else {
        // Send error if wallet info couldn't be retrieved
        console.warn('Invalid response received from background', response);
        const errorMessage: RiftErrorMessage = {
          type: 'rift:error',
          code: ERROR_CODES.WALLET_UNAVAILABLE,
          message: 'Could not get wallet context',
        };

        iframe.contentWindow?.postMessage(errorMessage, '*');
      }
    } catch (error) {
      // Clear timeout if there was an error
      clearTimeout(timeoutId);

      if (hasResponded) return;
      hasResponded = true;

      console.error('Error getting context from background:', error);

      // Send error to iframe
      const errorMessage: RiftErrorMessage = {
        type: 'rift:error',
        code: ERROR_CODES.WALLET_UNAVAILABLE,
        message: error.message || 'Error getting wallet context',
      };

      iframe.contentWindow?.postMessage(errorMessage, '*');
    }
  } catch (error) {
    console.error('Error handling Rift handshake:', error);

    // Send error to iframe
    const errorMessage: RiftErrorMessage = {
      type: 'rift:error',
      code: ERROR_CODES.UNKNOWN_ERROR,
      message: 'Error handling handshake',
    };

    iframe.contentWindow?.postMessage(errorMessage, '*');
  }
}

// Handle intent messages
async function handleIntent(iframe: HTMLIFrameElement, message: RiftIntentMessage): Promise<void> {
  try {
    switch (message.action) {
      case 'getUserAddress':
        try {
          // Get address using the new helper function
          const response = await sendMessageToBackground({ type: 'RIFT:GET_CONTEXT' });
          console.log('getUserAddress response:', response);

          // Enhanced validation for address response
          const hasValidAddress =
            response && typeof response.address === 'string' && response.address.length > 0;

          const network = (response && response.network) || 'mainnet';

          console.log('getUserAddress validation:', {
            hasValidAddress,
            addressType: response?.address ? typeof response.address : 'undefined',
            networkType: response?.network ? typeof response.network : 'undefined',
            responseType: typeof response,
          });

          if (hasValidAddress) {
            const contextMessage = {
              type: 'rift:context',
              address: response.address,
              network: network,
            };
            console.log('Sending address context to iframe:', contextMessage);
            iframe.contentWindow?.postMessage(contextMessage, '*');
          } else {
            console.warn('Invalid address response:', response);
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.WALLET_UNAVAILABLE,
                message: 'Wallet address not available',
              },
              '*'
            );
          }
        } catch (error) {
          console.error('Error getting address for getUserAddress:', error);
          iframe.contentWindow?.postMessage(
            {
              type: 'rift:error',
              code: ERROR_CODES.WALLET_UNAVAILABLE,
              message: error.message || 'Could not get wallet address',
            },
            '*'
          );
        }
        break;

      case 'query':
        // Execute a read-only script
        try {
          console.log('Handling Rift script request:', message);
          console.log('Script payload:', JSON.stringify(message.payload, null, 2));

          // Validate the payload is properly structured
          if (!message.payload || !message.payload.cadence) {
            console.error('Invalid script payload: Missing required cadence field');
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.INVALID_PAYLOAD,
                message: 'Invalid script payload: Missing required cadence field',
              },
              '*'
            );
            return;
          }

          // Make sure cadence is a string
          if (typeof message.payload.cadence !== 'string') {
            console.error('Invalid script payload: cadence must be a string');
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.INVALID_PAYLOAD,
                message: 'Invalid script payload: cadence must be a string',
              },
              '*'
            );
            return;
          }

          // Log the cadence script being sent to background
          console.log('Cadence script to execute:', message.payload.cadence);
          console.log('Script arguments:', message.payload.args || []);

          console.log('Sending script execution request to background');
          const response = await sendMessageToBackground({
            type: 'RIFT:EXECUTE_SCRIPT',
            payload: message.payload,
          });

          console.log('Script execution response received:', response);
          console.log('Response type:', typeof response);
          console.log('Response structure:', JSON.stringify(response, null, 2));

          if (response && response.error) {
            console.error('Script execution error:', response.error);
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.UNKNOWN_ERROR,
                message: response.error,
              },
              '*'
            );
          } else {
            // Process the script result to ensure we return something valid
            let result = response?.result;
            console.log('Raw script result:', result);
            console.log('Result type:', typeof result);

            // Check if we got a null or undefined result but should have a value
            if (
              (result === null || result === undefined) &&
              message.payload.cadence.includes('return')
            ) {
              console.warn('Script returned null/undefined when a value was expected');

              // For simple string returns, try to extract the value from the script
              const stringMatch = message.payload.cadence.match(/return\s+["'](.+?)["']/);
              if (stringMatch && stringMatch[1]) {
                console.log('Extracted string return value from script:', stringMatch[1]);
                result = stringMatch[1];
              }

              // Also check for numeric returns
              const numberMatch = message.payload.cadence.match(/return\s+(\d+\.?\d*)/);
              if (!result && numberMatch && numberMatch[1]) {
                console.log('Extracted numeric return value from script:', numberMatch[1]);
                result = numberMatch[1];
              }
            }

            console.log('Final processed result to send:', result);
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:queryResult',
                result: result,
              },
              '*'
            );
          }
        } catch (error) {
          console.error('Error executing Rift script:', error);
          console.error('Error details:', error.stack || 'No stack trace available');
          iframe.contentWindow?.postMessage(
            {
              type: 'rift:error',
              code: ERROR_CODES.UNKNOWN_ERROR,
              message: error.message || 'Script execution failed',
            },
            '*'
          );
        }
        break;

      case 'mutate':
        // Execute a transaction
        try {
          console.log('Handling Rift transaction request:', message);

          // Validate the payload is properly structured
          if (!message.payload || !message.payload.cadence) {
            console.error('Invalid transaction payload: Missing required cadence field');
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.INVALID_PAYLOAD,
                message: 'Invalid transaction payload: Missing required cadence field',
              },
              '*'
            );
            return;
          }

          // Make sure cadence is a string
          if (typeof message.payload.cadence !== 'string') {
            console.error('Invalid transaction payload: cadence must be a string');
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.INVALID_PAYLOAD,
                message: 'Invalid transaction payload: cadence must be a string',
              },
              '*'
            );
            return;
          }

          console.log('Sending transaction request to background');
          const response = await sendMessageToBackground({
            type: 'RIFT:EXECUTE_TRANSACTION',
            payload: message.payload,
          });

          if (response && response.error) {
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: response.code || ERROR_CODES.UNKNOWN_ERROR,
                message: response.error,
              },
              '*'
            );
          } else {
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:mutateResult',
                status: 'success',
                txId: response.txId,
              },
              '*'
            );
          }
        } catch (error) {
          console.error('Error executing Rift transaction:', error);
          iframe.contentWindow?.postMessage(
            {
              type: 'rift:error',
              code: ERROR_CODES.UNKNOWN_ERROR,
              message: error.message || 'Transaction failed',
            },
            '*'
          );
        }
        break;

      default:
        iframe.contentWindow?.postMessage(
          {
            type: 'rift:error',
            code: ERROR_CODES.NOT_SUPPORTED,
            message: `Action '${message.action}' not supported`,
          },
          '*'
        );
    }
  } catch (error) {
    console.error('Error handling Rift intent:', error);

    // Send error to iframe
    iframe.contentWindow?.postMessage(
      {
        type: 'rift:error',
        code: ERROR_CODES.UNKNOWN_ERROR,
        message: 'Error handling intent',
      },
      '*'
    );
  }
}
