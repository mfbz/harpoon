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

// Keep a reference to the active detector instance
let activeDetector: wallet.detector.RiftDetector | null = null;

// Generate a unique ID for a Rift URI based on its position in the document
function generateRiftUriId(node: Node, riftUrl: string): string {
  // Create a unique identifier based on the URL and node position
  const randomId = Math.random().toString(36).substr(2, 9);
  return `${riftUrl}_${randomId}`;
}

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

// Convert a rift:// URL to http:// or https:// based on development mode settings
function convertRiftUrl(riftUrl: string, useHttp: boolean = false): string {
  const protocol = useHttp ? 'http://' : 'https://';

  // Replace the rift:// scheme with the appropriate protocol
  // Make sure to keep the query parameters intact
  console.log('Converting Rift URL:', riftUrl);
  const converted = riftUrl.replace(RIFT_URI_SCHEME, protocol);
  console.log('Converted URL:', converted);
  return converted;
}

// Clean up the existing detector
function cleanupDetector(): void {
  if (activeDetector) {
    console.log('Cleaning up existing Rift detector');
    activeDetector.stop();
    activeDetector = null;
  }

  // Clear processed URLs cache
  processedRiftUrls.clear();
}

// Parse query parameters from a Rift URL
function getParamsFromRiftUrl(riftUrl: string): Record<string, string> {
  try {
    console.log('Raw Rift URL to parse:', riftUrl);
    const params: Record<string, string> = {};

    // Extract the query string from the rift URL
    // This needs to handle formats like "rift://domain.com?param=value"
    // or "rift://domain.com/path?param=value"
    const queryMatch = riftUrl.match(/[?&]([^#]*)/);
    console.log('Query match result:', queryMatch);

    if (!queryMatch || !queryMatch[1]) return params;

    const queryString = queryMatch[1];
    console.log('Extracted query string:', queryString);

    // Split and parse the parameters
    queryString.split('&').forEach((pair) => {
      const [key, value] = pair.split('=');
      if (key && value) {
        params[key] = decodeURIComponent(value);
        console.log(`Found parameter: ${key} = ${params[key]}`);
      }
    });

    return params;
  } catch (error) {
    console.error('Error parsing Rift URL parameters:', error);
    return {};
  }
}

// Determine if text should be white or black based on background color
function getTextColorForBackground(backgroundColor: string): string {
  try {
    // Ensure we have a # prefix for hex colors
    let hexColor = backgroundColor;
    if (hexColor && !hexColor.startsWith('#') && hexColor.match(/^[0-9A-Fa-f]{3,8}$/)) {
      hexColor = '#' + hexColor;
    }

    // Default to black if we can't parse the color
    if (!hexColor || !hexColor.startsWith('#')) {
      return '#000000';
    }

    // Convert hex to RGB
    let r, g, b;
    if (hexColor.length === 4) {
      // For shorthand #rgb format
      r = parseInt(hexColor[1] + hexColor[1], 16);
      g = parseInt(hexColor[2] + hexColor[2], 16);
      b = parseInt(hexColor[3] + hexColor[3], 16);
    } else {
      // For full #rrggbb format
      r = parseInt(hexColor.substring(1, 3), 16);
      g = parseInt(hexColor.substring(3, 5), 16);
      b = parseInt(hexColor.substring(5, 7), 16);
    }

    // Calculate luminance (perceived brightness)
    // Using the formula from WCAG 2.0
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

    // Use white text for dark backgrounds, black for light
    return luminance > 128 ? '#000000' : '#FFFFFF';
  } catch (error) {
    console.error('Error calculating text color:', error);
    return '#000000'; // Default to black on error
  }
}

// Generate a darker shade of a color for button background
function getDarkerShade(color: string): string {
  try {
    // Ensure we have a # prefix for hex colors
    let hexColor = color;
    if (hexColor && !hexColor.startsWith('#') && hexColor.match(/^[0-9A-Fa-f]{3,8}$/)) {
      hexColor = '#' + hexColor;
    }

    if (!hexColor || !hexColor.startsWith('#')) {
      return '#D7DFEA'; // Default button color
    }

    // Convert hex to RGB
    let r, g, b;
    if (hexColor.length === 4) {
      // For shorthand #rgb format
      r = parseInt(hexColor[1] + hexColor[1], 16);
      g = parseInt(hexColor[2] + hexColor[2], 16);
      b = parseInt(hexColor[3] + hexColor[3], 16);
    } else {
      // For full #rrggbb format
      r = parseInt(hexColor.substring(1, 3), 16);
      g = parseInt(hexColor.substring(3, 5), 16);
      b = parseInt(hexColor.substring(5, 7), 16);
    }

    // Darken by 15%
    r = Math.max(0, r - 40);
    g = Math.max(0, g - 40);
    b = Math.max(0, b - 40);

    // Convert back to hex
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  } catch (error) {
    console.error('Error calculating darker shade:', error);
    return '#D7DFEA'; // Default button color on error
  }
}

// Create and start a new detector instance
async function createAndStartDetector(
  httpDevMode: boolean
): Promise<wallet.detector.RiftDetector | null> {
  try {
    // Create a detector from rift-js
    const detector = new wallet.detector.RiftDetector({
      onRiftUriFound: async (node, riftUrl, range) => {
        try {
          // Generate a unique ID for this specific Rift URI instance
          const riftUriId = generateRiftUriId(node, riftUrl);

          // Skip if this specific instance has already been processed
          if (processedRiftUrls.has(riftUriId)) {
            return;
          }

          // Mark this URL instance as being processed
          processedRiftUrls.set(riftUriId, true);

          // Convert the rift URL to HTTPS (or HTTP for localhost when dev mode is on)
          const convertedUrl = convertRiftUrl(riftUrl, httpDevMode);
          console.log('convertedUrl', convertedUrl);

          // Parse domain from the URL
          const url = new URL(convertedUrl);
          const domain = url.hostname;

          // Get parameters from the Rift URL
          const riftParams = getParamsFromRiftUrl(riftUrl);
          console.log('riftParams', riftParams);

          // Direct check for rift-color in the URL as a fallback
          let riftColor = riftParams['rift-color'];
          console.log('rift-color from params:', riftColor);

          // If not found in the parsed params, try direct extraction
          if (!riftColor) {
            const colorMatch = riftUrl.match(/[?&]rift-color=([^&=#]*)/);
            if (colorMatch && colorMatch[1]) {
              riftColor = decodeURIComponent(colorMatch[1]);
              console.log('rift-color extracted directly:', riftColor);
            }
          }

          // Get custom background color from rift-color parameter, default to #F2F4F8
          let backgroundColor = riftColor || '#F2F4F8';

          // Make sure color has # prefix if it's a hex value
          if (backgroundColor && backgroundColor.match(/^[0-9A-Fa-f]{3,8}$/)) {
            backgroundColor = '#' + backgroundColor;
            console.log('Added # prefix to color:', backgroundColor);
          }

          console.log('Final background color:', backgroundColor);

          // Determine text color based on background brightness
          const textColor = getTextColorForBackground(backgroundColor);

          // Get darker shade of background color for button
          const buttonColor = getDarkerShade(backgroundColor);

          // Create a container at the detected position
          const riftFrame = document.createElement('div');
          riftFrame.className = 'rift-frame';
          riftFrame.style.border = 'none';
          riftFrame.style.borderRadius = '24px';
          riftFrame.style.overflow = 'hidden';
          riftFrame.style.backgroundColor = backgroundColor;
          riftFrame.style.margin = '8px 0px';
          riftFrame.style.maxWidth = '100%';

          // Create header
          const header = document.createElement('div');
          header.className = 'rift-header';
          header.style.display = 'flex';
          header.style.alignItems = 'center';
          header.style.justifyContent = 'space-between';
          header.style.padding = '12px 12px';
          header.style.backgroundColor = backgroundColor;

          // Create left side of header with favicon and title
          const headerLeft = document.createElement('div');
          headerLeft.style.display = 'flex';
          headerLeft.style.alignItems = 'center';
          headerLeft.style.gap = '6px';

          // Add rift emoji instead of favicon
          const riftEmoji = document.createElement('span');
          riftEmoji.textContent = '🌀';
          riftEmoji.style.fontSize = '14px';
          riftEmoji.style.lineHeight = '1';
          riftEmoji.style.display = 'flex';
          riftEmoji.style.alignItems = 'center';
          riftEmoji.style.justifyContent = 'center';

          // Create a circle background for the emoji using the button color
          const emojiContainer = document.createElement('div');
          emojiContainer.style.display = 'flex';
          emojiContainer.style.alignItems = 'center';
          emojiContainer.style.justifyContent = 'center';
          emojiContainer.style.backgroundColor = buttonColor;
          emojiContainer.style.borderRadius = '50%';
          emojiContainer.style.width = '26px';
          emojiContainer.style.height = '26px';
          emojiContainer.style.padding = '0px';
          emojiContainer.style.marginRight = '6px';

          // Append emoji to its circular container
          emojiContainer.appendChild(riftEmoji);

          // Add title
          const title = document.createElement('span');
          title.textContent = domain;
          title.style.fontSize = '14px';
          title.style.fontWeight = '500';
          title.style.color = textColor;

          headerLeft.appendChild(emojiContainer);
          headerLeft.appendChild(title);

          // Create inject button instead of a toggle
          const injectButton = document.createElement('button');
          injectButton.textContent = '🪝 Inject';
          injectButton.style.background = buttonColor;
          injectButton.style.border = 'none';
          injectButton.style.borderRadius = '16px';
          injectButton.style.padding = '4px 12px';
          injectButton.style.fontSize = '12px';
          injectButton.style.fontWeight = '500';
          injectButton.style.color = textColor;
          injectButton.style.cursor = 'pointer';
          injectButton.style.display = 'flex';
          injectButton.style.alignItems = 'center';
          injectButton.style.gap = '4px';

          // Add elements to header
          header.appendChild(headerLeft);
          header.appendChild(injectButton);

          // Create content container (initially hidden)
          const contentContainer = document.createElement('div');
          contentContainer.className = 'rift-content';
          contentContainer.style.display = 'none';
          contentContainer.style.width = '100%';

          // Add header and content to frame
          riftFrame.appendChild(header);
          riftFrame.appendChild(contentContainer);

          // Replace the original node with our rift frame
          range.deleteContents();
          range.insertNode(riftFrame);

          // Use the iframe injector from rift-js
          const injector = new wallet.injector.IframeInjector({
            onIframeInjected: (iframeEl) => {
              // Set up message handler for this iframe
              setupFrameMessageHandling(iframeEl);
            },
          });

          // Track if frame has been injected
          let frameInjected = false;
          let injectedIframe: HTMLIFrameElement | null = null;

          // Handle button click to inject or remove the frame
          injectButton.addEventListener('click', () => {
            if (!frameInjected) {
              // First click - inject the frame
              injectButton.textContent = '❌ Remove';

              // Show content container
              contentContainer.style.display = 'block';

              // Inject the iframe using the injector
              try {
                injectedIframe = injector.injectFrame(contentContainer, riftUrl);
                frameInjected = true;
                console.log('Rift frame injected successfully');
              } catch (error) {
                console.error('Error injecting Rift frame:', error);
              }
            } else {
              // Second click - remove the frame
              try {
                // Use the injector's removeFrame method to properly clean up
                // The removeFrame method expects the container element, not the iframe
                injector.removeFrame(contentContainer);
                injectedIframe = null;

                // Clear the content container to ensure we can re-inject later
                contentContainer.innerHTML = '';

                // Hide content container
                contentContainer.style.display = 'none';

                // Reset button text and state
                injectButton.textContent = '🪝 Inject';
                frameInjected = false;

                console.log('Rift frame removed successfully');
              } catch (error) {
                console.error('Error removing Rift frame:', error);
              }
            }
          });
        } catch (error) {
          // Clean up in case of error
          const riftUriId = generateRiftUriId(node, riftUrl);
          processedRiftUrls.delete(riftUriId);
          console.error('Error injecting Rift frame:', error);
        }
      },
    });

    // Start detection
    detector.start();
    return detector;
  } catch (error) {
    console.error('Error creating or starting Rift detector:', error);
    return null;
  }
}

// Set up listeners for various navigation events
function setupNavigationListeners(): void {
  // Listen for history state changes (pushState/replaceState)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  // Override pushState
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    console.log('History pushState detected, reprocessing Rift URIs');
    reprocessRiftUris();
    return result;
  };

  // Override replaceState
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    console.log('History replaceState detected, reprocessing Rift URIs');
    reprocessRiftUris();
    return result;
  };

  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', () => {
    console.log('Popstate event detected, reprocessing Rift URIs');
    reprocessRiftUris();
  });

  // Listen for hash changes
  window.addEventListener('hashchange', () => {
    console.log('Hash change detected, reprocessing Rift URIs');
    reprocessRiftUris();
  });

  // Track URL path changes for SPA navigation
  let lastPathname = window.location.pathname;
  let lastSearch = window.location.search;

  // Setup interval to check for URL path changes
  const pathCheckInterval = setInterval(() => {
    const currentPathname = window.location.pathname;
    const currentSearch = window.location.search;

    if (currentPathname !== lastPathname || currentSearch !== lastSearch) {
      console.log(
        'URL path/query change detected:',
        `${lastPathname}${lastSearch} -> ${currentPathname}${currentSearch}`
      );
      lastPathname = currentPathname;
      lastSearch = currentSearch;
      reprocessRiftUris();
    }
  }, 500);

  // Store the interval ID on window for cleanup if needed
  (window as any).__riftPathCheckInterval = pathCheckInterval;

  // Enhanced MutationObserver to detect general SPA navigation patterns
  const bodyObserver = new MutationObserver((mutations) => {
    // First, check for significant DOM changes that might indicate navigation
    const significantChanges = mutations.some(
      (mutation) => mutation.type === 'childList' && mutation.addedNodes.length > 5
    );

    if (significantChanges) {
      console.log('Significant DOM changes detected, reprocessing Rift URIs');
      reprocessRiftUris();
      return;
    }

    // Look for common UI navigation patterns across various sites
    const navigationPatterns = [
      // Common modal/dialog indicators
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.modal',
      '.dialog',

      // Common navigation containers
      'main',
      'article',
      'section[role="main"]',
      '[role="main"]',

      // Generic content containers
      '#content',
      '.content-container',
      '#main-content',

      // General navigation changes
      'nav[aria-current]',
      'a[aria-current="page"]',
      '[data-route]',
    ];

    // Check if any mutations affected navigation-related elements
    let navigationRelatedChanges = false;

    for (const mutation of mutations) {
      // Check for childList mutations (elements added or removed)
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // Check added nodes for navigation-related elements
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement) {
            // Check if this element matches any common navigation patterns
            try {
              for (const selector of navigationPatterns) {
                if (node.matches(selector) || node.querySelector(selector) !== null) {
                  navigationRelatedChanges = true;
                  break;
                }
              }

              if (navigationRelatedChanges) break;

              // Also check for content containers or main content areas
              if (
                node.id === 'content' ||
                node.id === 'main' ||
                node.classList.contains('content') ||
                node.getAttribute('role') === 'main'
              ) {
                navigationRelatedChanges = true;
                break;
              }
            } catch (e) {
              // Ignore selector matching errors
            }
          }
        }
      }

      // Check for attribute changes that might indicate navigation
      if (mutation.type === 'attributes') {
        const target = mutation.target as HTMLElement;

        // Check for changes to navigation-related attributes
        if (
          mutation.attributeName === 'aria-current' ||
          mutation.attributeName === 'aria-selected' ||
          mutation.attributeName === 'data-active' ||
          mutation.attributeName === 'data-page'
        ) {
          navigationRelatedChanges = true;
          break;
        }

        // Check for href changes on anchor elements
        if (mutation.attributeName === 'href' && target instanceof HTMLAnchorElement) {
          // Only consider this a navigation if the element has certain characteristics
          // that suggest it's a main navigation element
          if (
            target.parentElement?.tagName === 'NAV' ||
            target.getAttribute('role') === 'navigation' ||
            target.classList.contains('nav-item') ||
            target.getAttribute('aria-current') !== null
          ) {
            navigationRelatedChanges = true;
            break;
          }
        }
      }
    }

    if (navigationRelatedChanges) {
      console.log('Navigation-related DOM changes detected, reprocessing Rift URIs');
      reprocessRiftUris();
    }
  });

  // Start observing the document body with enhanced configuration
  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'href',
      'aria-current',
      'aria-selected',
      'aria-expanded',
      'data-active',
      'data-page',
      'data-route',
      'data-current',
    ],
  });

  // Store reference to allow cleanup if needed
  (window as any).__riftBodyObserver = bodyObserver;

  // Additional technique: Listen for focus/visibility changes
  // These can indicate tab switching or modal opening
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.log('Page became visible, reprocessing Rift URIs');
      reprocessRiftUris();
    }
  });

  // React to iframe focus events, which can indicate embedded content navigation
  window.addEventListener('blur', () => {
    // Check if an iframe was focused
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
      console.log('iframe focus detected, reprocessing Rift URIs');
      reprocessRiftUris();
    }
  });

  // Watch for scroll events that might indicate content loading
  let lastScrollY = window.scrollY;
  let scrollTimeout: number | null = null;

  window.addEventListener(
    'scroll',
    () => {
      // If user scrolled significantly (more than 200px)
      if (Math.abs(window.scrollY - lastScrollY) > 200) {
        lastScrollY = window.scrollY;

        // Debounce the scroll event
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }

        scrollTimeout = window.setTimeout(() => {
          console.log('Significant scroll detected, reprocessing Rift URIs');
          reprocessRiftUris();
          scrollTimeout = null;
        }, 500);
      }
    },
    { passive: true }
  );
}

// Function to reprocess Rift URIs after navigation
async function reprocessRiftUris(): Promise<void> {
  // Use a debounce mechanism to avoid multiple rapid reprocessing
  if ((window as any).__riftReprocessingTimeout) {
    clearTimeout((window as any).__riftReprocessingTimeout);
  }

  (window as any).__riftReprocessingTimeout = setTimeout(async () => {
    // Check if Rift is still enabled
    const enabled = await isRiftFramesEnabled();
    if (!enabled) {
      cleanupDetector();
      return;
    }

    // Get development mode setting
    const httpDevMode = await isHttpDevelopmentModeEnabled();

    // Clean up existing detector and clear processed URLs
    cleanupDetector();

    // Create and start a new detector
    activeDetector = await createAndStartDetector(httpDevMode);

    console.log('Rift detector restarted after navigation');
  }, 300); // Small delay to let the DOM update
}

// Clean up all resources when the content script is unloaded
function cleanupAllResources(): void {
  // Clean up the detector
  cleanupDetector();

  // Clear the path check interval if it exists
  if ((window as any).__riftPathCheckInterval) {
    clearInterval((window as any).__riftPathCheckInterval);
    delete (window as any).__riftPathCheckInterval;
  }

  // Disconnect the body observer if it exists
  if ((window as any).__riftBodyObserver) {
    (window as any).__riftBodyObserver.disconnect();
    delete (window as any).__riftBodyObserver;
  }

  // Clear any pending timeouts
  if ((window as any).__riftReprocessingTimeout) {
    clearTimeout((window as any).__riftReprocessingTimeout);
    delete (window as any).__riftReprocessingTimeout;
  }
}

// Main function to detect and inject Rift frames
export async function initRiftDetection(): Promise<void> {
  // Clean up any existing resources first (in case of re-initialization)
  cleanupAllResources();

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

  // Create and start a new detector
  activeDetector = await createAndStartDetector(httpDevMode);

  // Set up listeners for client-side navigation
  setupNavigationListeners();

  // Set up unload handler to clean up resources
  window.addEventListener('unload', cleanupAllResources);
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

          // Create a copy of the payload to avoid mutating the original
          const txPayload = { ...message.payload };

          // Check transaction content to determine if we should be an authorizer
          const needsAuthorizer =
            txPayload.cadence.includes('prepare(') ||
            (txPayload.cadence.includes('transaction') &&
              txPayload.cadence.includes('AuthAccount'));

          // If transaction has no roles specified, set them based on the needs
          if (!txPayload.roles) {
            console.log('Setting transaction roles based on content analysis:', {
              authorizer: needsAuthorizer,
            });
            txPayload.roles = {
              proposer: true,
              authorizer: needsAuthorizer,
              payer: true,
            };
          }

          const riftUrlAttribute = iframe.getAttribute('src');
          txPayload.riftUrl = riftUrlAttribute;

          console.log('Sending transaction request to background');
          const response = await sendMessageToBackground({
            type: 'RIFT:EXECUTE_TRANSACTION',
            payload: txPayload,
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
