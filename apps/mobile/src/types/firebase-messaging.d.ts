/**
 * Stub type declaration for @react-native-firebase/messaging.
 *
 * The push notification service dynamically imports this module and
 * gracefully degrades when it's not installed. This declaration
 * prevents TypeScript errors without requiring the package.
 */
declare module "@react-native-firebase/messaging" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messaging: any;
  export default messaging;
}
