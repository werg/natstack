#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <UserNotifications/UserNotifications.h>

#if __has_include(<FirebaseCore/FirebaseCore.h>)
#import <FirebaseCore/FirebaseCore.h>
#define NATSTACK_HAS_FIREBASE 1
#elif __has_include(<Firebase.h>)
#import <Firebase.h>
#define NATSTACK_HAS_FIREBASE 1
#else
#define NATSTACK_HAS_FIREBASE 0
#endif

#if __has_include(<RNFBMessaging/RNFBMessaging+AppDelegate.h>)
#import <RNFBMessaging/RNFBMessaging+AppDelegate.h>
#define NATSTACK_HAS_RNFB_MESSAGING 1
#elif __has_include("RNFBMessaging+AppDelegate.h")
#import "RNFBMessaging+AppDelegate.h"
#define NATSTACK_HAS_RNFB_MESSAGING 1
#else
#define NATSTACK_HAS_RNFB_MESSAGING 0
#endif

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
#if NATSTACK_HAS_FIREBASE
  if ([FIRApp defaultApp] == nil) {
    @try {
      [FIRApp configure];
    } @catch (NSException *exception) {
      NSLog(@"[NatStack] Firebase is not configured: %@", exception.reason);
    }
  }
#else
  NSLog(@"[NatStack] FirebaseCore headers are not available; skipping Firebase configure.");
#endif

  [UNUserNotificationCenter currentNotificationCenter].delegate = (id<UNUserNotificationCenterDelegate>)self;

  self.moduleName = @"NatStack";
  self.initialProps = @{};
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (void)application:(UIApplication *)application
    didReceiveRemoteNotification:(NSDictionary *)userInfo
          fetchCompletionHandler:(void (^)(UIBackgroundFetchResult))completionHandler
{
#if NATSTACK_HAS_RNFB_MESSAGING
  [[RNFBMessagingAppDelegate sharedInstance] application:application didReceiveRemoteNotification:userInfo fetchCompletionHandler:completionHandler];
#else
  completionHandler(UIBackgroundFetchResultNoData);
#endif
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
