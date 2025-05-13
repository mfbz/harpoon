import { Typography, Box } from '@mui/material';
import { makeStyles } from '@mui/styles';
import React from 'react';

import empty_status from '@/ui/FRWAssets/image/empty_status.svg';

const useStyles = makeStyles(() => ({
  emptyBox: {
    height: '249px',
    justifyContent: 'center',
    alignContent: 'center',
    textAlign: 'center',
  },
  emptyImg: {
    margin: '0 auto auto auto',
  },
  title: {
    fontSize: '16px',
    lineHeight: '24px',
    fontWeight: 600,
    marginTop: '16px',
    marginBottom: '4px',
    width: '100%',
    color: '#00B4D8',
  },
  subtitle: {
    fontSize: '14px',
    lineHeight: '20px',
    width: '100%',
    color: '#00B4D8',
  },
}));

function EmptyStatus() {
  const classes = useStyles();

  return (
    <Box className={classes.emptyBox}>
      <img className={classes.emptyImg} src={empty_status} height="167px" />
      <Typography
        sx={{
          fontSize: '16px',
          lineHeight: '24px',
          fontWeight: 600,
          marginTop: '8px',
          marginBottom: '4px',
          width: '100%',
          color: '#00B4D8',
        }}
      >
        {chrome.i18n.getMessage('We__did__not__find__anything__here')}
      </Typography>
      <Typography
        sx={{
          fontSize: '14px',
          lineHeight: '20px',
          width: '100%',
          color: '#00B4D8',
        }}
      >
        {chrome.i18n.getMessage('Looking__forward__to__your__new__discovery')}
      </Typography>
    </Box>
  );
}

export default EmptyStatus;
