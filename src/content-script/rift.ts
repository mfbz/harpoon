import {
  ERROR_CODES,
  RIFT_URI_SCHEME,
  RiftContextMessage,
  RiftErrorMessage,
  RiftHandshakeMessage,
  RiftIntentMessage,
  wallet,
} from 'rift-js';
import { storage } from '../background/webapi';

// Check if Rift Frames are enabled in settings
async function isRiftFramesEnabled(): Promise<boolean> {
  const riftEnabled = await storage.get('riftFramesEnabled');
  return riftEnabled === true;
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

// Ask user for permission to inject Rift frame
function promptForRiftInjection(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Create prompt UI
    const promptDiv = document.createElement('div');
    promptDiv.style.position = 'fixed';
    promptDiv.style.bottom = '20px';
    promptDiv.style.right = '20px';
    promptDiv.style.backgroundColor = '#1E1E1E';
    promptDiv.style.borderRadius = '12px';
    promptDiv.style.padding = '16px';
    promptDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
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

    // Add event listeners
    document.getElementById('rift-deny')?.addEventListener('click', () => {
      promptDiv.remove();
      resolve(false);
    });

    document.getElementById('rift-approve')?.addEventListener('click', () => {
      promptDiv.remove();
      resolve(true);
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

  // Create a detector and injector from rift-js
  const detector = new wallet.detector.RiftDetector({
    onRiftLinkFound: async (linkElement, riftUrl) => {
      try {
        // Parse domain from rift URL
        const url = new URL(riftUrl.replace(RIFT_URI_SCHEME, 'https://'));
        const domain = url.hostname;

        // Check if domain is already approved
        const approved = await isDomainApproved(domain);
        if (!approved) {
          // Prompt user for approval
          const userApproved = await promptForRiftInjection(domain);
          if (!userApproved) {
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

        // Inject the iframe
        injector.injectFrame(linkElement, riftUrl);
      } catch (error) {
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

// Run the rift detection when DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  initRiftDetection();
});
