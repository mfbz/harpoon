// Set environment badge based on branch

export const setEnvironmentBadge = () => {
  const deploymentEnv = process.env.DEPLOYMENT_ENV;

  if (deploymentEnv === 'production') {
    // No badge for production
    chrome.action.setBadgeText({ text: '' });
  } else if (deploymentEnv === 'staging') {
    // Single letter for staging
    chrome.action.setBadgeText({ text: 'S' });
  } else if (deploymentEnv === 'development') {
    // Single letter for development
    chrome.action.setBadgeText({ text: 'D' });
  } else {
    // Single letter for local development
    // TODO: change to L
    chrome.action.setBadgeText({ text: '' });
  }
  chrome.action.setBadgeBackgroundColor({ color: '#00B4D8' });
};
