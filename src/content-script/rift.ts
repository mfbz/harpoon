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
  // Check if the URL is for localhost or 127.0.0.1 and if we should use HTTP
  const isLocalhost = riftUrl.includes('localhost') || riftUrl.includes('127.0.0.1');
  const protocol = useHttp && isLocalhost ? 'http://' : 'https://';

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

  // Configure rift-js to use HTTP for local development if enabled
  if (httpDevMode) {
    // Use the setConfig function to configure HTTP for local development
    setConfig({
      useHttpForLocalDevelopment: true,
      localHosts: ['localhost', '127.0.0.1'],
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
    // Request wallet information from background script
    chrome.runtime.sendMessage({ type: 'RIFT:GET_CONTEXT' }, (response) => {
      if (response && response.address) {
        // Send wallet context back to iframe
        const contextMessage: RiftContextMessage = {
          type: 'rift:context',
          address: response.address,
          network: response.network || 'mainnet',
        };

        iframe.contentWindow?.postMessage(contextMessage, '*');
      } else {
        // Send error if wallet info couldn't be retrieved
        const errorMessage: RiftErrorMessage = {
          type: 'rift:error',
          code: ERROR_CODES.WALLET_UNAVAILABLE,
          message: 'Could not get wallet context',
        };

        iframe.contentWindow?.postMessage(errorMessage, '*');
      }
    });
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
        // Simply return the address from the wallet
        chrome.runtime.sendMessage({ type: 'RIFT:GET_CONTEXT' }, (response) => {
          if (response && response.address) {
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:context',
                address: response.address,
                network: response.network || 'mainnet',
              },
              '*'
            );
          } else {
            iframe.contentWindow?.postMessage(
              {
                type: 'rift:error',
                code: ERROR_CODES.WALLET_UNAVAILABLE,
                message: 'Wallet address not available',
              },
              '*'
            );
          }
        });
        break;

      case 'query':
        // Execute a read-only script
        chrome.runtime.sendMessage(
          {
            type: 'RIFT:EXECUTE_SCRIPT',
            payload: message.payload,
          },
          (response) => {
            if (response.error) {
              iframe.contentWindow?.postMessage(
                {
                  type: 'rift:error',
                  code: ERROR_CODES.UNKNOWN_ERROR,
                  message: response.error,
                },
                '*'
              );
            } else {
              iframe.contentWindow?.postMessage(
                {
                  type: 'rift:queryResult',
                  result: response.result,
                },
                '*'
              );
            }
          }
        );
        break;

      case 'mutate':
        // Execute a transaction
        chrome.runtime.sendMessage(
          {
            type: 'RIFT:EXECUTE_TRANSACTION',
            payload: message.payload,
          },
          (response) => {
            if (response.error) {
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
          }
        );
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
