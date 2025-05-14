import 'reflect-metadata';
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

        // Execute the script
        console.log('Executing script:', payload.cadence);
        let result;
        try {
          result = await walletController.sendRequest({
            cadence: payload.cadence,
            args: payload.args || [],
          });

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
          throw new Error(`Script execution failed: ${scriptError.message || 'Unknown error'}`);
        }

        const responseData = { result };
        console.log('Debug: Script execution result:', responseData);

        // Prepare the response with the message ID if available
        if (messageId) {
          const responseWithId = {
            responseId: messageId,
            data: responseData,
          };

          console.log('Debug: Response with ID:', responseWithId);

          // Send response to the active tab
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, responseWithId);
              console.log(`Sent script result to tab ${tabs[0].id} with ID ${messageId}`);
            } else if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, responseWithId);
              console.log(`Sent script result to sender tab ${sender.tab.id} with ID ${messageId}`);
            }
          });
        }

        // Also send via the standard callback mechanism as a fallback
        sendResponse(responseData);
      } catch (error) {
        console.error('Error executing Rift script:', error);

        const errorResponse = {
          error: error.message || 'Script execution failed',
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

        // Check if current address is flow address
        try {
          console.log('Debug: Checking if current address is flow address');
          let currentAddress: WalletAddress | null = null;

          try {
            currentAddress = await userWalletService.getCurrentAddress();
            console.log('Debug: Got currentAddress:', currentAddress);
          } catch (addressError) {
            console.error('Debug: Error getting currentAddress:', addressError);
          }

          if (currentAddress && !isValidFlowAddress(currentAddress)) {
            console.log(
              'Debug: Current address is not a valid Flow address. Getting parent address.'
            );
            let parentAddress: WalletAddress | null = null;

            try {
              parentAddress = await userWalletService.getParentAddress();
              console.log('Debug: Got parentAddress:', parentAddress);
            } catch (parentAddressError) {
              console.error('Debug: Error getting parentAddress:', parentAddressError);
            }

            if (!parentAddress) {
              throw new Error('Parent address not found');
            }

            try {
              console.log('Debug: Setting current account to parent address');
              await userWalletService.setCurrentAccount(
                parentAddress,
                parentAddress as WalletAddress
              );
              console.log('Debug: Successfully set current account to parent address');
            } catch (setAccountError) {
              console.error('Debug: Error setting current account:', setAccountError);
              throw new Error('Failed to set current account');
            }
          }
        } catch (error) {
          console.error('Error validating or setting current address:', error);
        }

        // Extract transaction details from request
        const { payload } = msg;

        // Get origin from sender for security
        const origin = new URL(sender.tab?.url || '').origin;

        // Convert Rift transaction to FCL-compatible format
        const fclCompatibleData = convertRiftToFCL({
          payload,
          tabId,
          origin,
          sender,
        });

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
            // Handle response from user
            if (response === 'rejected' || !response) {
              // User rejected the transaction
              sendResponse({
                error: 'Transaction rejected by user',
                code: 'user_rejected',
                status: 'error',
              });
              return;
            }

            try {
              // If we have a txId from the response, use it
              if (response.txId) {
                // Listen for transaction completion
                walletController.listenTransaction(response.txId, true);

                // Send response back to the content script
                sendResponse({
                  txId: response.txId,
                  status: 'success',
                });
              }
              // If we have an approved response from the modified Confirmation component
              else if (response.approved && response.transaction) {
                // Store the refBlock ID if provided (for transaction tracking)
                if (response.refBlock) {
                  await sessionStorage.setItem('pendingRefBlockId', response.refBlock);
                }

                // Execute the transaction now that it's been approved by the user
                const txId = await walletController.sendTransaction(
                  response.transaction,
                  response.args || []
                );

                // Listen for transaction completion
                walletController.listenTransaction(txId, true);

                // Send response back to the content script
                sendResponse({
                  txId,
                  status: 'success',
                });
              } else {
                // Execute the transaction if we don't have a txId
                const txId = await walletController.sendTransaction(
                  payload.cadence,
                  payload.args || []
                );

                // Listen for transaction completion
                walletController.listenTransaction(txId, true);

                // Send response back to the content script
                sendResponse({
                  txId,
                  status: 'success',
                });
              }
            } catch (error) {
              console.error('Error processing Rift transaction:', error);
              sendResponse({
                error: error.message || 'Transaction failed',
                code: 'unknown_error',
                status: 'error',
              });
            }
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
    roles: {
      proposer: true,
      authorizer: true,
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
