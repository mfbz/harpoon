import 'reflect-metadata';
import * as fcl from '@onflow/fcl';
import * as t from '@onflow/types';
import { ethErrors } from 'eth-rpc-errors';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  indexedDBLocalPersistence,
  setPersistence,
  onAuthStateChanged,
} from 'firebase/auth/web-extension';

import eventBus from '@/eventBus';
import { type WalletAddress } from '@/shared/types/wallet-types';
import { isValidFlowAddress } from '@/shared/utils/address';
import { Message } from '@/shared/utils/messaging';
import type { WalletController } from 'background/controller/wallet';
import { EVENTS } from 'consts';

import { providerController, walletController } from './controller';
import { preAuthzServiceDefinition } from './controller/serviceDefinition';
import {
  permissionService,
  preferenceService,
  sessionService,
  keyringService,
  openapiService,
  pageStateCacheService,
  coinListService,
  userInfoService,
  addressBookService,
  userWalletService,
  notificationService,
  transactionService,
  nftService,
  evmNftService,
  googleSafeHostService,
  mixpanelTrack,
} from './service';
import session from './service/session';
import { getFirbaseConfig } from './utils/firebaseConfig';
import { getAccountsByPublicKeyTuple } from './utils/modules/findAddressWithPubKey';
import { setEnvironmentBadge } from './utils/setEnvironmentBadge';
import { storage } from './webapi';
const { PortMessage } = Message;

const chromeWindow = await chrome.windows.getCurrent();

let appStoreLoaded = false;

async function initAppMeta() {
  // Initialize Firebase
  // console.log('<- initAppMeta ->')
  // const document = chromeWindow.document;
  // const head = document.querySelector('head');
  // const icon = document.createElement('link');
  // icon.href = 'https://raw.githubusercontent.com/Outblock/Lilico-Web/main/asset/icon-128.png';
  // icon.rel = 'icon';
  // head?.appendChild(icon);
  // const name = document.createElement('meta');
  // name.name = 'name';
  // name.content = 'Lilico';
  // head?.appendChild(name);
  // const description = document.createElement('meta');
  // description.name = 'description';
  // description.content = i18n.t('appDescription');
  // head?.appendChild(description);

  firebaseSetup();

  // note fcl setup is async
  await userWalletService.setupFcl();
}

async function firebaseSetup() {
  const env: string = process.env.NODE_ENV!;
  const firebaseConfig = getFirbaseConfig();
  console.log(process.env.NODE_ENV);
  // const firebaseProductionConfig = prodConig;

  const app = initializeApp(firebaseConfig, env);

  const auth = getAuth(app);
  setPersistence(auth, indexedDBLocalPersistence);
  onAuthStateChanged(auth, (user) => {
    if (user) {
      // User is signed in, see docs for a list of available properties
      // https://firebase.google.com/docs/reference/js/firebase.User
      // note fcl setup is async
      userWalletService.setupFcl();
    } else {
      // User is signed out
      signInAnonymously(auth);
    }
  });
}

async function restoreAppState() {
  // Load keyring store
  await keyringService.loadKeyringStore();
  // Init openapi. This starts fcl
  await openapiService.init();
  // clear premnemonic in storage
  storage.remove('premnemonic');
  storage.remove('tempPassword');
  // enable free gas fee
  storage.get('freeGas').then((value) => {
    if (value === null || value === undefined) {
      storage.set('freeGas', true);
    }
  });
  storage.get('lilicoPayer').then((value) => {
    if (value === null || value === undefined) {
      storage.set('lilicoPayer', true);
    }
  });

  // Init keyring and openapi first since this two service will not be migrated
  // await migrateData();

  await permissionService.init();
  await preferenceService.init();
  await pageStateCacheService.init();
  await coinListService.init();
  await userInfoService.init();
  await addressBookService.init();
  // Set the wallet controller before initializing userWalletService
  userWalletService.setWalletController(walletController);
  await userWalletService.init();
  await transactionService.init();
  await nftService.init();
  await evmNftService.init();
  await googleSafeHostService.init();
  await mixpanelTrack.init();
  // rpcCache.start();

  appStoreLoaded = true;

  await initAppMeta();

  // Set the loaded flag to true so that the UI knows the app is ready
  walletController.setLoaded(true);
  console.log('restoreAppState chrome.runtime.sendMessage->');
  chrome.runtime.sendMessage({ type: 'walletInitialized' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log(
        'chrome.runtime.sendMessage - Message delivery failed:',
        chrome.runtime.lastError.message
      );
    } else {
      console.log('chrome.runtime.sendMessage - Message delivered successfully:', response);
    }
  });
  console.log('restoreAppState chrome.tabs.query->');
  chrome.tabs
    .query({
      active: true,
      lastFocusedWindow: true,
    })
    .then((tabs) => {
      tabs.forEach((tab) => {
        const tabId = tab.id;
        if (tabId && !tab.url?.match(/^chrome*/)) {
          console.log('restoreAppState chrome.tabs.sendMessage->', tabId);
          chrome.tabs.sendMessage(tabId, { type: 'walletInitialized' }, (response) => {
            if (chrome.runtime.lastError) {
              console.log(
                'chrome.tabs.sendMessage - Message delivery failed:',
                chrome.runtime.lastError.message
              );
              // You can implement retry logic or alternative actions here
            } else {
              console.log('chrome.tabs.sendMessage - Message delivered successfully:', response);
            }
          });
        }
      });
    });
}

restoreAppState();

chrome.runtime.onInstalled.addListener(({ reason }: chrome.runtime.InstalledDetails) => {
  // chrome.runtime.OnInstalledReason.Install
  if (reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('index.html'),
    });
  } else {
    walletController.clearAllStorage();
  }
});

function forceReconnect(port) {
  deleteTimer(port);
  port.disconnect();
}

function deleteTimer(port) {
  if (port._timer) {
    clearTimeout(port._timer);
    delete port._timer;
  }
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request === 'ping') {
    sendResponse('pong');
    return;
  }
  sendResponse();
});

// for page provider
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  // openapiService.getConfig();

  // @ts-ignore
  port._timer = setTimeout(forceReconnect, 250e3, port);
  port.onDisconnect.addListener(deleteTimer);

  if (port.name === 'popup' || port.name === 'notification' || port.name === 'tab') {
    const pm = new PortMessage(port);
    pm.listen((data) => {
      // console.log('PortMessage ->', data);
      if (data?.type) {
        switch (data.type) {
          case 'broadcast':
            eventBus.emit(data.method, data.params);
            break;
          case 'openapi':
            if (walletController.openapi[data.method]) {
              return walletController.openapi[data.method].apply(null, data.params);
            }
            break;
          case 'controller':
          default:
            if (data.method) {
              return walletController[data.method].apply(null, data.params);
            }
        }
      }
    });

    const boardcastCallback = (data: any) => {
      pm.request({
        type: 'broadcast',
        method: data.method,
        params: data.params,
      });
    };

    if (port.name === 'popup') {
      preferenceService.setPopupOpen(true);

      port.onDisconnect.addListener(() => {
        preferenceService.setPopupOpen(false);
      });
    }

    eventBus.addEventListener(EVENTS.broadcastToUI, boardcastCallback);
    port.onDisconnect.addListener(() => {
      eventBus.removeEventListener(EVENTS.broadcastToUI, boardcastCallback);
    });

    return;
  }

  if (!port.sender?.tab) {
    return;
  }

  const pm = new PortMessage(port);

  pm.listen(async (data) => {
    // if (!appStoreLoaded) {
    //   throw ethErrors.provider.disconnected();
    // }

    // console.log('pm.listen ->', data);

    const sessionId = port.sender?.tab?.id;
    const session = sessionService.getOrCreateSession(sessionId);

    const req = { data, session };
    // for background push to respective page
    req.session.pushMessage = (event, data) => {
      pm.send('message', { event, data });
    };

    return providerController(req);
  });
});

declare global {
  interface Window {
    wallet: WalletController;
  }
}

// for popup operate
chromeWindow['wallet'] = new Proxy(walletController, {
  get(target, propKey, receiver) {
    if (!appStoreLoaded) {
      throw ethErrors.provider.disconnected();
    }
    return Reflect.get(target, propKey, receiver);
  },
});

const findPath = (service) => {
  switch (service.type) {
    case 'authn':
      return 'Connect';
    case 'authz':
      return 'Confirmation';
    case 'user-signature':
      return 'SignMessage';
    default:
      return 'Connect';
  }
};

const handlePreAuthz = async (id) => {
  // setApproval(true);
  // const wallet = await
  const payer = await walletController.getPayerAddressAndKeyId();
  const address = await userWalletService.getCurrentAddress();
  const network = await userWalletService.getNetwork();

  const keyIndex = await userWalletService.getKeyIndex();
  const services = preAuthzServiceDefinition(
    address,
    keyIndex,
    payer.address,
    payer.keyId,
    network
  );

  // console.log('handlePreAuthz ->', services, opener, id)
  if (id) {
    chrome.tabs.sendMessage(id, { status: 'APPROVED', data: services });
    // chrome.tabs.sendMessage(id, services)

    // if (chrome.tabs) {
    //   if (windowId) {
    //     chrome.windows.update(windowId, { focused: true })
    //   }
    //   // await chrome.tabs.highlight({tabs: tabId})
    //   await chrome.tabs.update(id, { active: true });
    // }
    // resolveApproval();
  }
};

// chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
//   console.log('wake me up');
// });

// Function called when a new message is received
const extMessageHandler = (msg, sender, sendResponse) => {
  // Messages from FCL, posted to window and proxied from content.js
  const { service } = msg;

  // console.log('extMessageHandler ->', msg)

  if (msg.type === 'FLOW::TX') {
    // DO NOT LISTEN
    walletController.listenTransaction(msg.txId, false);
    // fcl.tx(msg.txId).subscribe(txStatus => {})
  }

  if (msg.type === 'FCW:CS:LOADED') {
    chrome.tabs
      .query({
        active: true,
        lastFocusedWindow: true,
      })
      .then((tabs) => {
        const tabId = tabs[0].id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'FCW:NETWORK',
            network: userWalletService.getNetwork(),
          });
        }
      });
  }

  // Handle Rift protocol messages
  if (msg.type === 'RIFT:GET_CONTEXT') {
    console.log('Background: Received RIFT:GET_CONTEXT request', msg);
    const messageId = msg.messageId; // Extract the message ID

    (async () => {
      try {
        console.log('Debug: Before getCurrentAddress - appStoreLoaded:', appStoreLoaded);
        console.log('Debug: Is wallet locked:', !keyringService.isUnlocked());

        // Use a try-catch since getCurrentPubkey will throw if there's an issue
        let currentPubkeySet = false;
        try {
          const pubkey = userWalletService.getCurrentPubkey();
          currentPubkeySet = !!pubkey;
          console.log('Debug: Current pubkey set:', currentPubkeySet);
        } catch (pubkeyError) {
          console.error('Debug: Error checking pubkey:', pubkeyError);
        }

        let address;
        try {
          address = await userWalletService.getCurrentAddress();
          console.log('Debug: Successfully got address:', address);
        } catch (addressError) {
          console.error('Debug: Error getting address:', addressError);
          address = null;
        }

        let network;
        try {
          network = await userWalletService.getNetwork();
          console.log('Debug: Successfully got network:', network);
        } catch (networkError) {
          console.error('Debug: Error getting network:', networkError);
          network = null;
        }

        console.log('Background: Sending RIFT context response with address:', address);
        // Ensure we're providing non-null values and that the response is properly structured
        const responseData = {
          address: address || null,
          network: network || null,
        };

        // Prepare the response with the message ID
        const responseWithId = {
          responseId: messageId,
          data: responseData,
        };

        console.log('Debug: Sending response object:', JSON.stringify(responseData));
        console.log('Debug: Response with ID:', responseWithId);

        if (messageId) {
          // If we have a message ID, use the new response format
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, responseWithId);
              console.log(`Sent response to tab ${tabs[0].id} with ID ${messageId}`);
            } else {
              console.error('Could not find active tab to send response to');
              // Fallback to sending directly to sender
              if (sender?.tab?.id) {
                chrome.tabs.sendMessage(sender.tab.id, responseWithId);
                console.log(`Sent response to sender tab ${sender.tab.id} with ID ${messageId}`);
              } else {
                console.error('Could not find sender tab to send response to');
              }
            }
          });
        }

        // Also send via the standard callback mechanism as a fallback
        sendResponse(responseData);
      } catch (error) {
        console.error('Error getting context for Rift:', error);

        const errorResponse = { error: 'Failed to get wallet context' };

        if (messageId) {
          // If we have a message ID, use the new response format for errors too
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                responseId: messageId,
                data: errorResponse,
              });
            } else if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, {
                responseId: messageId,
                data: errorResponse,
              });
            }
          });
        }

        // Also send via the standard callback mechanism as a fallback
        sendResponse(errorResponse);
      }
    })();
    return true; // Keep channel open for async response
  }

  if (msg.type === 'RIFT:EXECUTE_SCRIPT') {
    // Execute script from Rift frame
    console.log('Background: Received RIFT:EXECUTE_SCRIPT request', msg);
    console.log('Background: RIFT script message ID:', msg.messageId);
    console.log('Background: RIFT script payload:', JSON.stringify(msg.payload, null, 2));
    const messageId = msg.messageId; // Extract the message ID

    (async () => {
      try {
        // Extract script details from request
        const { payload } = msg;

        if (!payload || !payload.cadence) {
          console.error('Invalid script payload - missing cadence');
          const errorResponse = {
            error: 'Invalid script payload - missing cadence',
            status: 'error',
          };

          if (messageId) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                  responseId: messageId,
                  data: errorResponse,
                });
              } else if (sender?.tab?.id) {
                chrome.tabs.sendMessage(sender.tab.id, {
                  responseId: messageId,
                  data: errorResponse,
                });
              }
            });
          }

          sendResponse(errorResponse);
          return;
        }

        // Extra validation to ensure cadence is a string
        if (typeof payload.cadence !== 'string') {
          console.error('Invalid script payload - cadence must be a string');
          const errorResponse = {
            error: 'Invalid script payload - cadence must be a string',
            status: 'error',
          };

          if (messageId) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, {
                  responseId: messageId,
                  data: errorResponse,
                });
              } else if (sender?.tab?.id) {
                chrome.tabs.sendMessage(sender.tab.id, {
                  responseId: messageId,
                  data: errorResponse,
                });
              }
            });
          }

          sendResponse(errorResponse);
          return;
        }

        // Execute the script directly using FCL instead of using the provider flow
        console.log('Background: Preparing to execute script with cadence:', payload.cadence);
        console.log('Background: Script arguments:', payload.args || []);
        console.log('Background: Executing script directly with FCL...');

        let result;
        try {
          // Direct FCL query execution instead of going through provider/wallet controller
          result = await fcl.query({
            cadence: payload.cadence,
            args: (arg, t) => {
              // If no args, return empty array
              if (!payload.args || !Array.isArray(payload.args) || payload.args.length === 0) {
                return [];
              }

              // Convert args to FCL format
              return payload.args.map((argValue) => {
                // Basic type inference - would need to be expanded for more complex types
                if (typeof argValue === 'number') {
                  return arg(argValue, t.Int);
                } else if (typeof argValue === 'string') {
                  return arg(argValue, t.String);
                } else if (typeof argValue === 'boolean') {
                  return arg(argValue, t.Bool);
                } else {
                  // Default to string for complex types
                  return arg(String(argValue), t.String);
                }
              });
            },
          });

          console.log('Background: Script execution completed, raw result:', result);
          console.log('Background: Result type:', typeof result);

          // Process the result to ensure we have a proper value
          if (result === undefined || result === null) {
            console.warn('Script execution returned undefined or null');

            // For simple scripts with string returns, try to extract the value
            if (payload.cadence.includes('return') && payload.cadence.includes('main()')) {
              const stringMatch = payload.cadence.match(/return\s+["'](.+?)["']/);
              if (stringMatch && stringMatch[1]) {
                console.log('Extracted string return value from script:', stringMatch[1]);
                result = stringMatch[1];
              }

              // Also check for numeric returns
              const numberMatch = payload.cadence.match(/return\s+(\d+\.?\d*)/);
              if (!result && numberMatch && numberMatch[1]) {
                console.log('Extracted numeric return value from script:', numberMatch[1]);
                result = numberMatch[1];
              }
            }
          }
        } catch (scriptError) {
          console.error('Error in script execution:', scriptError);
          console.error('Script error details:', scriptError.stack || 'No stack trace available');
          throw new Error(`Script execution failed: ${scriptError.message || 'Unknown error'}`);
        }

        const responseData = { result };
        console.log('Debug: Script execution result:', responseData);
        console.log('Debug: Response data to send back:', JSON.stringify(responseData, null, 2));

        // Prepare the response with the message ID if available
        if (messageId) {
          const responseWithId = {
            responseId: messageId,
            data: responseData,
          };

          console.log('Debug: Response with ID:', responseWithId);
          console.log('Debug: Sending response to tab...');

          // Send response to the active tab
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, responseWithId);
              console.log(`Sent script result to tab ${tabs[0].id} with ID ${messageId}`);
            } else if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, responseWithId);
              console.log(`Sent script result to sender tab ${sender.tab.id} with ID ${messageId}`);
            } else {
              console.error('Could not find any tab to send response to');
            }
          });
        } else {
          console.log('Debug: No messageId available, using sendResponse directly');
        }

        // Also send via the standard callback mechanism as a fallback
        console.log('Debug: Sending response via sendResponse callback');
        sendResponse(responseData);
      } catch (error) {
        console.error('Error executing Rift script:', error);
        console.error('Error stack:', error.stack || 'No stack trace available');

        const errorResponse = {
          error: error.message || 'Script execution failed',
          code: 'unknown_error',
          status: 'error',
        };

        if (messageId) {
          // Send error response with ID
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                responseId: messageId,
                data: errorResponse,
              });
              console.log(`Sent error response to tab ${tabs[0].id}`);
            } else if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, {
                responseId: messageId,
                data: errorResponse,
              });
              console.log(`Sent error response to sender tab ${sender.tab.id}`);
            } else {
              console.error('Could not find any tab to send error response to');
            }
          });
        }

        // Also send via the standard callback mechanism as a fallback
        console.log('Debug: Sending error response via sendResponse callback');
        sendResponse(errorResponse);
      }
    })();

    return true; // Keep channel open for async response
  }

  if (msg.type === 'RIFT:EXECUTE_TRANSACTION') {
    // Handle transaction from Rift frame
    console.log('Background: Received RIFT:EXECUTE_TRANSACTION request', msg);
    const messageId = msg.messageId; // Extract the message ID

    // Handle transaction from Rift frame
    chrome.tabs
      .query({
        active: true,
        lastFocusedWindow: true,
      })
      .then(async (tabs) => {
        const tabId = tabs[0]?.id;

        // Handle potential validation errors early
        if (!msg.payload || !msg.payload.cadence) {
          console.error('Invalid transaction payload - missing cadence');
          const errorResponse = {
            error: 'Invalid transaction payload - missing cadence',
            code: 'invalid_payload',
            status: 'error',
          };

          // If we have a message ID, use the new response format for errors
          if (messageId) {
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                responseId: messageId,
                data: errorResponse,
              });
            } else if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, {
                responseId: messageId,
                data: errorResponse,
              });
            }
          }

          // Also send via the standard callback mechanism as a fallback
          sendResponse(errorResponse);
          return;
        }

        // Extract transaction details from request
        const { payload } = msg;

        // Get origin from sender for security
        const origin = new URL(sender.tab?.url || '').origin;
        console.log('Debug: Transaction origin:', origin);
        console.log('Debug: Transaction cadence:', payload.cadence);
        console.log('Debug: Transaction args:', payload.args || []);

        // Convert Rift transaction to FCL-compatible format for the popup
        const fclCompatibleData = convertRiftToFCL({
          payload,
          tabId,
          origin,
          sender,
        });

        console.log('Debug: Opening approval popup with FCL-compatible data:', fclCompatibleData);

        // Open the approval popup
        notificationService
          .requestApproval(
            {
              params: fclCompatibleData,
              approvalComponent: 'Confirmation',
            },
            { height: 700 }
          )
          .then(async (response) => {
            console.log('Debug: Approval response received:', JSON.stringify(response, null, 2));

            // Handle response from user
            if (response === 'rejected' || !response) {
              // User rejected the transaction
              console.log('Debug: Transaction rejected by user');
              const rejectResponse = {
                error: 'Transaction rejected by user',
                code: 'user_rejected',
                status: 'error',
              };

              // If we have a message ID, use the new response format for the rejection
              if (messageId && tabId) {
                chrome.tabs.sendMessage(tabId, {
                  responseId: messageId,
                  data: rejectResponse,
                });
              } else if (messageId && sender?.tab?.id) {
                chrome.tabs.sendMessage(sender.tab.id, {
                  responseId: messageId,
                  data: rejectResponse,
                });
              }

              sendResponse(rejectResponse);
              return;
            }

            try {
              console.log('Debug: Processing approved transaction response type:', typeof response);
              console.log('Debug: Response keys available:', Object.keys(response || {}));

              // If we have a txId from the response, use it
              if (response.txId) {
                console.log('Debug: Using txId directly from response:', response.txId);

                // Listen for transaction completion
                walletController.listenTransaction(response.txId, true);

                // Prepare successful response
                const successResponse = {
                  txId: response.txId,
                  status: 'success',
                };

                // If we have a message ID, use the new response format for the success
                if (messageId && tabId) {
                  chrome.tabs.sendMessage(tabId, {
                    responseId: messageId,
                    data: successResponse,
                  });
                } else if (messageId && sender?.tab?.id) {
                  chrome.tabs.sendMessage(sender.tab.id, {
                    responseId: messageId,
                    data: successResponse,
                  });
                }

                // Send response back to the content script
                sendResponse(successResponse);
              }
              // If we have an approved response from the modified Confirmation component
              else if (
                (response.approved && response.transaction) ||
                (response.rift && response.approved)
              ) {
                console.log(
                  'Debug: Using approved transaction from response, cadence:',
                  response.transaction
                    ? response.transaction.substring(0, 50) + '...'
                    : 'using payload'
                );
                console.log('Debug: Args:', response.args || payload.args);
                console.log('Debug: Is Rift transaction:', !!response.rift);

                // Execute the transaction using our direct FCL method
                console.log('Debug: Sending transaction via direct FCL method');
                let txId;
                try {
                  // Use response.transaction if available, otherwise fall back to payload.cadence
                  const transactionCode = response.transaction || payload.cadence;
                  const transactionArgs = response.args || payload.args || [];

                  console.log(
                    'Debug: Final transaction code:',
                    transactionCode.substring(0, 50) + '...'
                  );
                  console.log('Debug: Final transaction args:', transactionArgs);

                  // Use the direct FCL transaction method instead of walletController
                  txId = await sendRiftTransaction(transactionCode, transactionArgs);
                  console.log('Debug: Transaction sent, txId:', txId);
                } catch (txError) {
                  console.error('Debug: Error sending transaction:', txError);
                  throw txError;
                }

                // Listen for transaction completion
                walletController.listenTransaction(txId, true);

                // Prepare successful response
                const successResponse = {
                  txId,
                  status: 'success',
                };

                // If we have a message ID, use the new response format for the success
                if (messageId && tabId) {
                  chrome.tabs.sendMessage(tabId, {
                    responseId: messageId,
                    data: successResponse,
                  });
                } else if (messageId && sender?.tab?.id) {
                  chrome.tabs.sendMessage(sender.tab.id, {
                    responseId: messageId,
                    data: successResponse,
                  });
                }

                // Send response back to the content script
                sendResponse(successResponse);
              } else {
                // Execute the transaction if we don't have specific info from the approval response
                console.log('Debug: No transaction in approval response, using original payload');
                console.log('Debug: Original cadence:', payload.cadence.substring(0, 50) + '...');
                console.log('Debug: Original args:', payload.args);

                let txId;
                try {
                  // Use direct FCL method instead of walletController
                  txId = await sendRiftTransaction(payload.cadence, payload.args || []);
                  console.log('Debug: Transaction sent, txId:', txId);
                } catch (txError) {
                  console.error('Debug: Error sending transaction with original payload:', txError);
                  throw txError;
                }

                // Listen for transaction completion
                walletController.listenTransaction(txId, true);

                // Prepare successful response
                const successResponse = {
                  txId,
                  status: 'success',
                };

                // If we have a message ID, use the new response format for the success
                if (messageId && tabId) {
                  chrome.tabs.sendMessage(tabId, {
                    responseId: messageId,
                    data: successResponse,
                  });
                } else if (messageId && sender?.tab?.id) {
                  chrome.tabs.sendMessage(sender.tab.id, {
                    responseId: messageId,
                    data: successResponse,
                  });
                }

                // Send response back to the content script
                sendResponse(successResponse);
              }
            } catch (error) {
              console.error('Error processing Rift transaction:', error);
              console.error('Error stack:', error.stack || 'No stack trace');
              const errorResponse = {
                error: error.message || 'Transaction failed',
                code: 'unknown_error',
                status: 'error',
              };

              // If we have a message ID, use the new response format for the error
              if (messageId && tabId) {
                chrome.tabs.sendMessage(tabId, {
                  responseId: messageId,
                  data: errorResponse,
                });
              } else if (messageId && sender?.tab?.id) {
                chrome.tabs.sendMessage(sender.tab.id, {
                  responseId: messageId,
                  data: errorResponse,
                });
              }

              sendResponse(errorResponse);
            }
          })
          .catch((error) => {
            // Handle errors from the notification service
            console.error('Error in notification service:', error);
            const errorResponse = {
              error: error.message || 'Transaction approval failed',
              code: 'approval_error',
              status: 'error',
            };

            // If we have a message ID, use the new response format for the error
            if (messageId && tabId) {
              chrome.tabs.sendMessage(tabId, {
                responseId: messageId,
                data: errorResponse,
              });
            } else if (messageId && sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, {
                responseId: messageId,
                data: errorResponse,
              });
            }

            sendResponse(errorResponse);
          });
      });

    return true; // Keep channel open for async response
  }

  if (msg.type === 'RIFT:GET_ADDRESS') {
    (async () => {
      try {
        console.log('Debug: Received RIFT:GET_ADDRESS request');
        console.log('Debug: Before getCurrentAddress - appStoreLoaded:', appStoreLoaded);
        console.log('Debug: Is wallet locked:', !keyringService.isUnlocked());

        let address: WalletAddress | null = null;
        try {
          address = await userWalletService.getCurrentAddress();
          console.log('Debug: Successfully got address:', address);
        } catch (addressError) {
          console.error('Debug: Error getting address:', addressError);
        }

        console.log('Debug: Sending RIFT:GET_ADDRESS response with address:', address);
        const response = {
          address: address || null,
        };
        console.log('Debug: Sending response object:', response);
        sendResponse(response);
      } catch (error) {
        console.error('Error getting address for Rift:', error);
        sendResponse({ error: 'Failed to get wallet address' });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (msg.type === 'RIFT:GET_NETWORK') {
    (async () => {
      try {
        let network: string | null = null;
        try {
          network = await userWalletService.getNetwork();
          console.log('Debug: Successfully got network:', network);
        } catch (networkError) {
          console.error('Debug: Error getting network:', networkError);
        }

        console.log('Debug: Sending RIFT:GET_NETWORK response with network:', network);
        const response = {
          network: network || 'mainnet',
        };
        console.log('Debug: Sending response object:', response);
        sendResponse(response);
      } catch (error) {
        console.error('Error getting network for Rift:', error);
        sendResponse({ error: 'Failed to get wallet network' });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Launches extension popup window
  if (
    service?.endpoint &&
    (service?.endpoint === 'chrome-extension://hpclkefagolihohboafpheddmmgdffjm/popup.html' ||
      service?.endpoint ===
        'chrome-extension://hpclkefagolihohboafpheddmmgdffjm/popup.html?network=testnet')
  ) {
    chrome.tabs
      .query({
        active: true,
        lastFocusedWindow: true,
      })
      .then(async (tabs) => {
        const tabId = tabs[0].id;

        // Check if current address is flow address
        try {
          const currentAddress = await userWalletService.getCurrentAddress();
          if (!isValidFlowAddress(currentAddress)) {
            const parentAddress = await userWalletService.getParentAddress();
            if (!parentAddress) {
              throw new Error('Parent address not found');
            }
            await userWalletService.setCurrentAccount(
              parentAddress,
              parentAddress as WalletAddress
            );
          }
        } catch (error) {
          console.error('Error validating or setting current address:', error);
        }
        if (service.type === 'pre-authz') {
          handlePreAuthz(tabId);
        } else {
          console.log('notificationService.requestApproval ->', service, findPath(service));
          console.log('notificationService.msg ->', msg);
          notificationService
            .requestApproval(
              {
                params: { tabId, type: service.type },
                approvalComponent: findPath(service),
              },
              { height: service.type === 'authz' ? 700 : 620 }
            )
            .then((res) => {
              if (res === 'unlocked') {
                notificationService.requestApproval(
                  {
                    params: { tabId, type: service.type },
                    approvalComponent: findPath(service),
                  },
                  { height: service.type === 'authz' ? 700 : 620 }
                );
              }
            });
        }
      });
  }

  // Handle direct approval messages from the Confirmation popup
  if (msg.type === 'RIFT:TRANSACTION_APPROVED') {
    console.log('Background: Received direct RIFT:TRANSACTION_APPROVED message:', msg);

    // Use the same pattern as our other async handlers
    (async () => {
      try {
        const { payload } = msg;
        const originalTabId = payload.originalTabId;
        const originalMessageId = payload.originalMessageId;

        console.log('Debug: Directly sending transaction via direct FCL method');
        const txId = await sendRiftTransaction(payload.transaction, payload.args || []);
        console.log('Debug: Direct transaction sent, txId:', txId);

        // Listen for transaction completion
        walletController.listenTransaction(txId, true);

        // Prepare successful response
        const successResponse = {
          txId,
          status: 'success',
        };

        // If we have the original message ID and tab ID, send the response
        if (originalMessageId && originalTabId) {
          chrome.tabs.sendMessage(originalTabId, {
            responseId: originalMessageId,
            data: successResponse,
          });
        }

        sendResponse(successResponse);
      } catch (error) {
        console.error('Error processing direct Rift transaction approval:', error);
        sendResponse({
          error: error.message || 'Transaction failed',
          code: 'unknown_error',
          status: 'error',
        });
      }
    })();

    return true; // Keep channel open for async response
  }

  sendResponse({ status: 'ok' });
  // return true
};

/**
 * Fired when a message is sent from either an extension process or a content script.
 */
chrome.runtime.onMessage.addListener(extMessageHandler);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'foo') return;
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(deleteTimer);
  port['_timer'] = setTimeout(forceReconnect, 250e3, port);
});

function onMessage(msg, port) {
  console.log('received', msg, 'from', port.sender);
}

console.log('Is fetch native?', fetch.toString().includes('[native code]'));

// Call it when extension starts
setEnvironmentBadge();

function saveTimestamp() {
  const timestamp = new Date().toISOString();

  chrome.storage.session.set({ timestamp });
}

const SAVE_TIMESTAMP_INTERVAL_MS = 2 * 1000;

saveTimestamp();
setInterval(saveTimestamp, SAVE_TIMESTAMP_INTERVAL_MS);

// Function to convert Rift transaction data to FCL compatible format
function convertRiftToFCL({ payload, tabId, origin, sender }) {
  // Create a synthetic FCL-compatible message body
  const body = {
    cadence: payload.cadence,
    message: '', // Will be set by wallet during signing process
    addr: '', // Will be filled by wallet
    keyId: 0, // Will be filled by wallet
    roles: payload.roles || {
      proposer: true,
      authorizer: false, // Default to false to avoid authorizer count mismatch errors
      payer: true,
    },
    voucher: {
      refBlock: '', // Will be filled by wallet
      payloadSigs: [],
    },
    f_type: 'Signable',
  };

  // Create FCL-compatible config structure
  const config = {
    client: {
      hostname: origin,
      network: payload.network || 'mainnet',
    },
    app: {
      title: payload.title || 'Rift Transaction',
      icon: payload.icon || sender.tab?.favIconUrl || '',
    },
  };

  // Combine into FCL-compatible parameters
  return {
    tabId,
    type: 'authz',
    rift: true, // Flag to identify it as a Rift transaction
    icon: sender.tab?.favIconUrl,
    origin,
    host: origin,
    body, // FCL compatible body
    config, // FCL compatible config
    arguments: payload.args || [],
    cadence: payload.cadence,
  };
}

// Function to directly execute a transaction using FCL methods
// This is ONLY used for Rift transactions to avoid authorizer issues
// DO NOT USE THIS FOR REGULAR WALLET TRANSACTIONS - it's a specialized handler
// that only modifies the transaction flow for Rift frames to fix the
// "authorizer count mismatch" error.
async function sendRiftTransaction(cadence: string, args: any[] = []) {
  console.log('Rift-specific FCL transaction execution');

  // Parse the transaction to check if it has a prepare block with AuthAccount parameters
  // This is the standard way FCL determines if a transaction needs authorizers
  const needsAuthorizer =
    cadence.includes('prepare') && (cadence.includes('AuthAccount') || cadence.includes('auth'));

  console.log('Transaction needs authorizer:', needsAuthorizer);

  try {
    // Ensure current account is set to a valid Flow address
    let currentAddress = await userWalletService.getCurrentAddress();
    if (currentAddress && !isValidFlowAddress(currentAddress)) {
      const parentAddress = await userWalletService.getParentAddress();
      if (!parentAddress) {
        throw new Error('Parent address not found');
      }
      await userWalletService.setCurrentAccount(parentAddress, parentAddress as WalletAddress);
    }

    // Convert args to FCL-compatible format
    const fclArgs = () => {
      if (!args || args.length === 0) {
        return [];
      }

      return args.map((arg) => {
        if (typeof arg === 'number') return fcl.arg(arg, t.Int);
        if (typeof arg === 'string') {
          if (arg.startsWith('0x')) return fcl.arg(arg, t.Address);
          return fcl.arg(arg, t.String);
        }
        if (typeof arg === 'boolean') return fcl.arg(arg, t.Bool);
        return fcl.arg(String(arg), t.String);
      });
    };

    // Use FCL directly with proper configuration based on transaction needs
    if (needsAuthorizer) {
      // For transactions that DO need authorizers, use standard FCL behavior
      console.log('Using standard FCL transaction flow for authorizer transaction');
      return await fcl.mutate({
        cadence: cadence,
        args: fclArgs,
        proposer: userWalletService.authorizationFunction,
        authorizations: [userWalletService.authorizationFunction],
        payer: userWalletService.payerAuthFunction,
        limit: 9999,
      });
    } else {
      // For transactions that DON'T need authorizers, use empty authorizations
      console.log('Using FCL transaction flow with EMPTY authorizations');
      return await fcl.mutate({
        cadence: cadence,
        args: fclArgs,
        proposer: userWalletService.authorizationFunction,
        authorizations: [], // Empty array - no authorizers
        payer: userWalletService.payerAuthFunction,
        limit: 9999,
      });
    }
  } catch (error) {
    console.error('Error in Rift transaction execution:', error);
    throw error;
  }
}
