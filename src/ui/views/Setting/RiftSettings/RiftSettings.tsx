import { Switch, switchClasses } from '@mui/base/Switch';
import { Box, Typography, Fade } from '@mui/material';
import { makeStyles } from '@mui/styles';
import { styled } from '@mui/system';
import React, { useState, useEffect, useCallback } from 'react';

import { storage } from '@/background/webapi';
import { LLHeader } from '@/ui/FRWComponent';
import { useWallet } from 'ui/utils';

const useStyles = makeStyles(() => ({
  riftBox: {
    width: 'auto',
    height: 'auto',
    margin: '10px 20px',
    backgroundColor: '#02033B',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'row',
    borderRadius: '16px',
    alignContent: 'space-between',
  },
  descriptionText: {
    marginTop: '8px',
    fontSize: '14px',
    opacity: 0.8,
  },
}));

const grey = {
  400: '#00B4D8',
  500: '#00B4D8',
  600: '#02033B',
};

const Root = styled('span')(
  ({ theme }) => `
    font-size: 0;
    position: relative;
    display: inline-block;
    width: 40px;
    height: 20px;
    // margin: 0;
    margin-left: auto;
    cursor: pointer;

    &.${switchClasses.disabled} {
      opacity: 0.4;
      cursor: not-allowed;
    }

    & .${switchClasses.track} {
      background: ${theme.palette.mode === 'dark' ? grey[600] : grey[400]};
      border-radius: 10px;
      display: block;
      height: 100%;
      width: 100%;
      position: absolute;
    }

    & .${switchClasses.thumb} {
      display: block;
      width: 14px;
      height: 14px;
      top: 3px;
      left: 3px;
      border-radius: 16px;
      background-color: #fff;
      position: relative;
      transition: all 200ms ease;
    }

    &.${switchClasses.focusVisible} .${switchClasses.thumb} {
      background-color: ${grey[500]};
      box-shadow: 0 0 1px 8px rgba(0, 0, 0, 0.25);
    }

    &.${switchClasses.checked} {
      .${switchClasses.thumb} {
        left: 22px;
        top: 3px;
        background-color: #fff;
      }

      .${switchClasses.track} {
        background: ${grey[500]};
      }
    }

    & .${switchClasses.input} {
      cursor: inherit;
      position: absolute;
      width: 100%;
      height: 100%;
      top: 0;
      left: 0;
      opacity: 0;
      z-index: 1;
      margin: 0;
    }
    `
);

const RiftSettings = () => {
  const usewallet = useWallet();
  const classes = useStyles();
  const [riftFramesEnabled, setRiftFramesEnabled] = useState(false);

  const loadSettings = useCallback(async () => {
    const riftEnabled = await storage.get('riftFramesEnabled');
    return { riftEnabled: riftEnabled === true };
  }, []);

  useEffect(() => {
    let mounted = true;

    loadSettings().then(({ riftEnabled }) => {
      if (!mounted) return;
      setRiftFramesEnabled(riftEnabled);
    });

    return () => {
      mounted = false;
    };
  }, [loadSettings]);

  const toggleRiftFrames = async () => {
    setRiftFramesEnabled((prev) => {
      const newState = !prev;
      storage.set('riftFramesEnabled', newState);
      return newState;
    });
  };

  return (
    <div className="page">
      <LLHeader title={chrome.i18n.getMessage('Rift_Frames')} help={false} />

      <Box className={classes.riftBox}>
        <Box>
          <Typography variant="body1" color="neutral.contrastText" style={{ weight: 600 }}>
            {chrome.i18n.getMessage('Rift_Frames')}
          </Typography>
          <Typography
            variant="body2"
            color="neutral.contrastText"
            className={classes.descriptionText}
          >
            {chrome.i18n.getMessage('Rift_Frames_Description')}
          </Typography>
        </Box>
        <Switch
          checked={riftFramesEnabled}
          slots={{
            root: Root,
          }}
          onChange={() => {
            toggleRiftFrames();
          }}
        />
      </Box>
    </div>
  );
};

export default RiftSettings;
