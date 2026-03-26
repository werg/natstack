/**
 * Panel-side OAuth client — re-exports the shared implementation.
 */
export {
  createOAuthClient,
  type OAuthToken,
  type OAuthConnection,
  type OAuthClient,
  type OAuthStartAuthResult,
  type ConsentRecord,
} from "../shared/oauth.js";
