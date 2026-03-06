// Dev mode detection
export const IS_DEV = !!process.env.ELECTRON_RENDERER_URL

// Auth server port - single port so OAuth callback URLs are consistent across dev/prod
export const AUTH_SERVER_PORT = 21321
