/** Read once at bundle time; Expo inlines EXPO_PUBLIC_* variables. See .env.example. */
export const MERCHANT_ADDRESS = process.env.EXPO_PUBLIC_MERCHANT_ADDRESS ?? "";
export const RELAYER_URL = process.env.EXPO_PUBLIC_RELAYER_URL || null;

/** How long a payment request stays valid; becomes the tx maxTime. */
export const REQUEST_TTL_SECONDS = 15 * 60;
