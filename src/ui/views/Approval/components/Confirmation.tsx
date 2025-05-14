import { Stack, Box } from '@mui/material';
import * as fcl from '@onflow/fcl';
import dedent from 'dedent';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type UserInfoResponse } from '@/shared/types/network-types';
import {
  LLPrimaryButton,
  LLSecondaryButton,
  LLConnectLoading,
  LLLinkingLoading,
} from '@/ui/FRWComponent';
import { useApproval, useWallet } from 'ui/utils';
// import { CHAINS_ENUM } from 'consts';

import './github-dark-dimmed.css';

import { DefaultBlock } from './DefaultBlock';
import { LinkingBlock } from './LinkingBlock';

interface ConnectProps {
  params: any;
  // onChainChange(chain: CHAINS_ENUM): void;
  // defaultChain: CHAINS_ENUM;
}

const Confirmation = ({ params }: ConnectProps) => {
  const {
    icon,
    origin,
    tabId,
    type,
    rift,
    body,
    config,
    host: paramHost,
    cadence,
    arguments: args,
  } = params || {};
  const [, resolveApproval, rejectApproval, linkningConfirm] = useApproval();
  const { t } = useTranslation();
  const wallet = useWallet();
  const [signable, setSignable] = useState<Signable | null>(null);
  // const [payerSignable, setPayerSignable] = useState<Signable | null>(null);
  const [opener, setOpener] = useState<number | undefined>(undefined);
  const [host, setHost] = useState(null);
  const [cadenceArguments, setCadenceArguments] = useState<any[]>([]);
  const [cadenceScript, setCadenceScript] = useState<string>('');
  const [approval, setApproval] = useState(false);
  const [windowId, setWindowId] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [linkingDone, setLinkingDone] = useState(false);
  const [accountLinking, setAccountLinking] = useState(false);
  const [accountArgs, setAccountArgs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lilicoEnabled, setLilicoEnabled] = useState(true);
  const [auditor, setAuditor] = useState<any>(null);
  const [image, setImage] = useState<string>('');
  const [accountTitle, setAccountTitle] = useState<string>('');
  const [userInfo, setUserInfo] = useState<UserInfoResponse | null>(null);
  const [title, setTitle] = useState('');

  // TODO: replace default logo
  const [logo, setLogo] = useState('');
  interface Roles {
    authorizer: boolean;
    payer: boolean;
    proposer: boolean;
  }
  interface Signable {
    cadence: string;
    message: string;
    addr: string;
    keyId: number;
    roles: Roles;
    voucher: Voucher;
    f_type: string;
  }
  interface Voucher {
    refBlock: string;
    payloadSigs: Signature;
  }
  interface Signature {
    address: string;
    keyId: number;
    sig: string | null;
  }

  const getUserInfo = useCallback(async () => {
    const userResult = await wallet.getUserInfo(false);
    await setUserInfo(userResult);
  }, [wallet]);

  // useEffect(() => {
  //   getUserInfo();
  //   const index = accountArgs.findIndex(item => item.value.includes('.jpg'));
  //   console.log(' accountArgs ', data);
  //   if (accountArgs[index]) {
  //     setImage(accountArgs[index].value)
  //     setAccountTitle(accountArgs[4].value)
  //   }
  // }, [accountArgs])

  const fetchTxInfo = useCallback(
    async (cadence: string) => {
      // const account = await wallet.getCurrentAccount();
      const network = await wallet.getNetwork();
      const result = await wallet.openapi.getTransactionTemplate(cadence, network);
      if (result !== null) {
        setAuditor(result);
        setExpanded(false);
      }
    },
    [wallet]
  );

  const handleCancel = useCallback(() => {
    if (opener) {
      if (windowId) {
        chrome.windows.update(windowId, { focused: true });
        chrome.tabs.update(opener, { active: true });
      }
      chrome.tabs.sendMessage(opener, {
        f_type: 'PollingResponse',
        f_vsn: '1.0.0',
        status: 'DECLINED',
        reason: 'User rejected the request.',
      });
      chrome.tabs.sendMessage(opener, { type: 'FCL:VIEW:CLOSE' });
      setApproval(false);
      rejectApproval('User rejected the request.');
    }
  }, [opener, windowId, rejectApproval]);

  const fclCallback = useCallback(
    (data) => {
      console.log('fclCallback received data:', data);
      if (typeof data !== 'object') {
        console.error('fclCallback: data is not an object');
        return;
      }
      if (data.type !== 'FCL:VIEW:READY:RESPONSE') {
        console.error('fclCallback: data.type is not FCL:VIEW:READY:RESPONSE', data.type);
        return;
      }

      console.log('fclCallback processing FCL:VIEW:READY:RESPONSE with body:', data.body);
      const newSignable: Signable = data.body;
      console.log('fclCallback created signable object:', {
        hasMessage: !!newSignable.message,
        hasAddr: !!newSignable.addr,
        hasKeyId: newSignable.keyId !== undefined,
        hasRoles: !!newSignable.roles,
        hasVoucher: !!newSignable.voucher,
        messageLength: newSignable.message ? newSignable.message.length : 0,
      });

      const hostname = data.config?.client?.hostname;
      if (hostname) {
        setHost(hostname);
      }
      setImage(data.config.app.icon);
      setAccountTitle(data.config.app.title);
      const firstLine = newSignable.cadence.trim().split('\n')[0];

      const isAccountLinking = firstLine.includes('#allowAccountLinking');
      setAccountLinking(isAccountLinking);
      if (isAccountLinking) {
        setAccountArgs(newSignable['args']);
      }

      console.log('fclCallback setting signable and triggering useEffect dependencies');
      setSignable(newSignable);
      getUserInfo();

      fetchTxInfo(newSignable.cadence);
    },
    [fetchTxInfo, getUserInfo]
  );

  const sendAuthzToFCL = async () => {
    try {
      console.log('sendAuthzToFCL ==>', signable);
      console.log('Rift transaction flag:', rift);
      console.log('Current transaction data:', { cadence, args, body });

      // Special handling for Rift transactions - may not have all the FCL fields
      if (rift) {
        console.log('This is a Rift transaction - taking direct approval path');
        setApproval(true);

        // For Rift transactions, directly resolve with transaction data
        console.log('Directly resolving approval for Rift transaction');
        try {
          // First attempt: standard useApproval method
          resolveApproval({
            txId: null, // Will be generated by the background script
            transaction: cadence,
            args: args,
            approved: true,
            rift: true,
          });
          console.log('Successfully resolved approval for Rift transaction');

          // Backup approach: try to communicate directly with background script
          console.log('Also trying direct chrome.runtime.sendMessage as backup');
          chrome.runtime.sendMessage(
            {
              type: 'RIFT:TRANSACTION_APPROVED',
              payload: {
                transaction: cadence,
                args: args,
                approved: true,
                rift: true,
                originalTabId: tabId,
                originalMessageId: params.messageId,
              },
            },
            (response) => {
              console.log('Received response from direct background message:', response);
            }
          );

          return;
        } catch (error) {
          console.error('Error resolving approval for Rift transaction:', error);
          throw error;
        }
      }

      // Normal FCL flow for regular transactions
      if (!signable) {
        console.error('No signable object available. This is required for transaction approval.');
        return;
      }

      setApproval(true);

      try {
        console.log(
          'Attempting to sign message with message:',
          signable.message.substring(0, 50) + '...'
        );
        const signedMessage = await wallet.signMessage(signable.message);
        console.log(
          'Message signed successfully, result length:',
          signedMessage ? signedMessage.length : 'null'
        );

        // console.log('signedMessage ->', opener, lilicoEnabled)
        // console.log('signedMessage ->', signedMessage)
        if (opener) {
          console.log('Sending signature to opener tab:', opener);
          sendSignature(signable, signedMessage);

          const value = await sessionStorage.getItem('pendingRefBlockId');
          console.log('pendingRefBlockId from session storage:', value);

          // console.log('pendingRefBlockId ->', value);
          if (value !== null) {
            console.log('RefBlock ID already exists in session storage, returning early');
            return;
          }

          console.log('Setting pendingRefBlockId in session storage:', signable.voucher.refBlock);
          sessionStorage.setItem('pendingRefBlockId', signable.voucher.refBlock);

          if (lilicoEnabled) {
            console.log('Lilico payer is enabled, sending FCL:VIEW:READY message to tab:', opener);
            chrome.tabs.sendMessage(opener, { type: 'FCL:VIEW:READY' });
            // const tx = signable.voucher
            // tx.payloadSigs[0].sig = signedMessage
            // const message = sdk.encodeTransactionEnvelope(tx)
            // const payer = await wallet.getPayerAddressAndKeyId()
            // const mockSignable = {voucher: tx, message: message, addr: payer.address, keyId: payer.keyId}
            // // console.log('mockSignable ->', mockSignable)
            // signPayer(mockSignable)
            // sendSignature(mockSignable, payerSig)
            // setApproval(true);
            // resolveApproval();
          } else {
            setApproval(true);
            console.log('Resolving approval with Rift transaction data:', {
              transaction: cadence,
              args: args,
              rift: rift,
              approved: true,
              refBlock: signable.voucher.refBlock,
            });

            resolveApproval();
          }
        } else {
          console.error('No opener tab ID available, cannot send approval response');
        }
      } catch (signError) {
        console.error('Error signing message:', signError);
        throw signError;
      }
    } catch (error) {
      console.error('Fatal error in sendAuthzToFCL:', error);
      // If anything goes wrong, still try to resolve with at least the basic data
      if (rift) {
        try {
          console.log('Attempting to resolve approval after error');
          resolveApproval({
            transaction: cadence,
            args: args,
            approved: true,
            error: error.message,
          });
        } catch (resolveError) {
          console.error('Error in fallback resolveApproval:', resolveError);
        }
      }
    }
  };

  const sendSignature = useCallback(
    (signable, signedMessage) => {
      if (opener) {
        chrome.tabs.sendMessage(opener, {
          f_type: 'PollingResponse',
          f_vsn: '1.0.0',
          status: 'APPROVED',
          reason: null,
          data: new fcl.WalletUtils.CompositeSignature(
            signable.addr,
            signable.keyId,
            signedMessage
          ),
        });
      }
    },
    [opener]
  );

  const signPayer = useCallback(
    async (signable) => {
      setIsLoading(true);
      const value = await sessionStorage.getItem('pendingRefBlockId');

      console.log('signPayer ->', signable.voucher.refBlock, value, signable.roles.payer);

      if (signable.roles.payer !== true) {
        return;
      }

      if (signable.voucher.refBlock !== value) {
        return;
      }

      try {
        const signedMessage = await wallet.signPayer(signable);
        sendSignature(signable, signedMessage);
        setApproval(true);
        // if (accountLinking) {
        //   await linkningConfirm();
        // } else {
        //   resolveApproval();
        //   setIsLoading(false);
        // }
        resolveApproval();
        setIsLoading(false);
      } catch (err) {
        setIsLoading(false);
        handleCancel();
      }
    },
    [wallet, sendSignature, resolveApproval, handleCancel, setIsLoading]
  );

  const loadPayer = useCallback(async () => {
    const isEnabled = await wallet.allowLilicoPay();
    setLilicoEnabled(isEnabled);
  }, [wallet]);

  useEffect(() => {
    loadPayer();

    return () => {
      sessionStorage.removeItem('pendingRefBlockId');

      // @ts-ignore
      chrome.storage.session?.remove('pendingRefBlockId');
    };
  }, [loadPayer]);

  useEffect(() => {
    console.log('pendingRefBlockId ->', lilicoEnabled, signable, approval);
    if (lilicoEnabled && signable && signable.message && approval) {
      signPayer(signable);
    }
  }, [approval, lilicoEnabled, signPayer, signable]);

  // Handle Rift transaction if present in props
  useEffect(() => {
    if (type === 'authz' && rift === true && body) {
      // Process params as if they came from FCL for consistency
      const riftMsg = {
        type: 'FCL:VIEW:READY:RESPONSE',
        body: {
          cadence: cadence,
          args: args,
          ...body,
        },
        config: config,
        host: paramHost,
      };

      // Use the same processing logic as FCL messages
      console.log('Processing Rift transaction as FCL -->', riftMsg);
      console.log('Current state before processing:', {
        signable,
        host,
        cadenceArguments,
        cadenceScript,
        approval,
      });

      if (paramHost) {
        setHost(paramHost);
      }
      if (config?.app?.title) {
        setTitle(config.app.title);
      }
      if (config?.app?.icon) {
        setLogo(config.app.icon);
      }
      if (cadence) {
        setCadenceScript(cadence);
      }
      if (args?.length > 0) {
        setCadenceArguments(args);
      }

      // Process through the same callback for consistency
      fclCallback(JSON.parse(JSON.stringify(riftMsg)));
    }
  }, [rift, body, paramHost, config, cadence, args, fclCallback]);

  useEffect(() => {
    if (chrome.tabs) {
      chrome.tabs
        .query({
          active: true,
          currentWindow: false,
        })
        .then((tabs) => {
          const targetTab = tabs.filter((item) => item.id === tabId);

          let host = '';
          if (targetTab[0].url) {
            host = new URL(targetTab[0].url).host;
          }
          setWindowId(targetTab[0].windowId);
          //  setTabId(tabs[0].index)
          setLogo(targetTab[0].favIconUrl || '');
          setTitle(targetTab[0].title || '');
          setOpener(targetTab[0].id);
          chrome.tabs.sendMessage(targetTab[0].id || 0, { type: 'FCL:VIEW:READY' });
        });
    }

    const extMessageHandler = (msg, sender, sendResponse) => {
      // console.log('extMessageHandler -->', msg);

      if (msg.type === 'FCL:VIEW:READY:RESPONSE') {
        console.log('FCL:VIEW:READY:RESPONSE -->', msg.type, msg);

        if (msg.host) {
          setHost(msg.host);
        }
        if (msg.config?.app?.title) {
          setTitle(msg.config.app.title);
        }
        if (msg.config?.app?.icon) {
          setLogo(msg.config.app.icon);
        }
        if (msg.body?.cadence) {
          setCadenceScript(msg.body.cadence);
        }
        if (msg.body?.args?.length > 0) {
          setCadenceArguments(msg.body.args);
        }
        fclCallback(JSON.parse(JSON.stringify(msg || {})));
      }

      // if (msg.msg === 'transferListReceived') {
      //   // DO NOT LISTEN
      //   console.log('FLOW::TX -->', msg.type, msg);
      //   setLinkingDone(true);
      // }
      // if (msg.type === 'FLOW::TX') {
      //   // DO NOT LISTEN
      //   console.log('FLOW::TX -->', msg.type, msg);
      //   // fcl.tx(msg.txId).subscribe(txStatus => {})
      // }
      sendResponse({ status: 'ok' });
      return true;
    };

    chrome.runtime?.onMessage.addListener(extMessageHandler);

    return () => {
      chrome.runtime?.onMessage.removeListener(() => {
        console.log('removeListener');
      });
    };
  }, [fclCallback, tabId]);

  window.onbeforeunload = () => {
    if (!approval) {
      handleCancel();
    }
  };

  // Add a useEffect to monitor the signable object
  useEffect(() => {
    console.log(
      'Signable object changed:',
      signable
        ? {
            hasMessage: !!signable.message,
            hasAddr: !!signable.addr,
            hasKeyId: typeof signable.keyId !== 'undefined',
            hasRoles: !!signable.roles,
            hasVoucher: !!signable.voucher,
          }
        : 'null'
    );
  }, [signable]);

  // Add a useEffect to monitor component lifecycle
  useEffect(() => {
    console.log('Confirmation component mounted with rift:', rift);

    return () => {
      console.log('Confirmation component unmounting');
    };
  }, []);

  return (
    <>
      {isLoading ? (
        <Box>
          {accountLinking ? (
            <LLLinkingLoading
              linkingDone={linkingDone}
              image={image}
              accountTitle={accountTitle}
              userInfo={userInfo}
            />
          ) : (
            <LLConnectLoading logo={logo} />
          )}
          {/* <LLConnectLoading logo={logo} /> */}
        </Box>
      ) : (
        <Box
          sx={{
            margin: '18px 18px 0px 18px',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            height: '100%',
            background: '#03045E',
          }}
        >
          {accountLinking ? (
            <LinkingBlock image={image} accountTitle={accountTitle} userInfo={userInfo} />
          ) : (
            <DefaultBlock
              title={title}
              host={host}
              auditor={auditor}
              expanded={expanded}
              lilicoEnabled={lilicoEnabled}
              cadenceArguments={cadenceArguments}
              logo={logo}
              cadenceScript={cadenceScript}
              setExpanded={setExpanded}
              dedent={dedent}
            />
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Stack direction="row" spacing={1} sx={{ paddingBottom: '32px' }}>
            <LLSecondaryButton
              label={chrome.i18n.getMessage('Cancel')}
              fullWidth
              onClick={handleCancel}
            />
            <LLPrimaryButton
              label={chrome.i18n.getMessage('Approve')}
              fullWidth
              type="submit"
              onClick={(e) => {
                console.log('Approve button clicked');
                console.log('Current state at click time:', {
                  signable: signable ? 'present' : 'null',
                  rift,
                  cadence: cadence ? cadence.substring(0, 20) + '...' : 'null',
                  args: args || [],
                });
                sendAuthzToFCL();
              }}
            />
          </Stack>
        </Box>
      )}
    </>
  );
};

export default Confirmation;
