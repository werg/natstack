#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTReloadCommand.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>

@interface NatStackMobileHost : NSObject <RCTBridgeModule>
@end

@implementation NatStackMobileHost

RCT_EXPORT_MODULE();

static NSString *const NatStackKeychainService = @"com.natstack.mobile.host";
static NSString *const NatStackCredentialAccount = @"mobile-refresh";
static NSString *const NatStackActiveBundleLocalPath = @"activeBundle.localPath";
static NSString *const NatStackActiveBundleBuildKey = @"activeBundle.buildKey";
static NSString *const NatStackActiveBundleIntegrity = @"activeBundle.integrity";
static NSString *const NatStackActiveBundleSource = @"activeBundle.source";
static NSString *const NatStackWorkspaceAppCallerPrefix = @"app:apps/";

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  BOOL firebaseConfigured = [[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"] != nil;
  return @{ @"firebaseConfigured": @(firebaseConfigured) };
}

RCT_EXPORT_METHOD(getCredentials:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSDictionary *credential = [self loadCredential];
    if (credential == nil) {
      resolve(nil);
      return;
    }
    NSMutableDictionary *publicCredential = [@{
      @"serverUrl": credential[@"serverUrl"],
      @"deviceId": credential[@"deviceId"],
      @"serverId": credential[@"serverId"],
      @"workspaceId": credential[@"workspaceId"],
    } mutableCopy];
    resolve(publicCredential);
  } @catch (NSException *exception) {
    reject(@"needs_repair", @"Stored mobile credentials could not be decrypted", nil);
  }
}

RCT_EXPORT_METHOD(clearCredentials:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [self clearStoredCredentials];
  resolve(nil);
}

RCT_EXPORT_METHOD(completePairing:(NSString *)serverUrl
                  code:(NSString *)code
                  source:(NSString *)source
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      NSString *normalizedUrl = [self normalizeServerUrl:serverUrl];
      NSDictionary *response = [self postJson:normalizedUrl path:@"/_r/s/auth/complete-pairing" body:@{
        @"code": code,
        @"label": @"Mobile device",
        @"platform": @"mobile",
      }];
      NSDictionary *credential = @{
        @"serverUrl": normalizedUrl,
        @"deviceId": [self requiredString:response key:@"deviceId"],
        @"refreshToken": [self requiredString:response key:@"refreshToken"],
        @"serverId": [self requiredString:response key:@"serverId"],
        @"workspaceId": [self requiredString:response key:@"workspaceId"],
      };
      [self saveCredential:credential];
      @try {
        resolve([self issueGrantForCredential:credential source:source]);
      } @catch (NSException *exception) {
        [self clearStoredCredentials];
        @throw;
      }
    } @catch (NSException *exception) {
      reject(@"pairing_failed", exception.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(issueConnectionGrant:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      NSDictionary *credential = [self loadCredential];
      if (credential == nil) {
        [NSException raise:@"NatStackNoCredentials" format:@"No mobile credentials are stored"];
      }
      resolve([self issueGrantForCredential:credential source:[self activeAppSource]]);
    } @catch (NSException *exception) {
      reject(@"grant_failed", exception.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(prepareAppBundle:(NSString *)expectedRnHostAbi
                  platform:(NSString *)platform
                  source:(NSString *)source
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      NSDictionary *credential = [self loadCredential];
      if (credential == nil) {
        [NSException raise:@"NatStackNoCredentials" format:@"No mobile credentials are stored"];
      }
      NSMutableDictionary *body = [@{
        @"deviceId": credential[@"deviceId"],
        @"refreshToken": credential[@"refreshToken"],
      } mutableCopy];
      if ([source isKindOfClass:[NSString class]] && source.length > 0) {
        body[@"source"] = source;
      }
      NSDictionary *response = [self postJson:credential[@"serverUrl"] path:@"/_r/s/auth/mobile-app-bootstrap" body:body];
      NSDictionary *bootstrap = response[@"bootstrap"];
      if (![bootstrap isKindOfClass:[NSDictionary class]]) {
        [NSException raise:@"NatStackBundleBootstrapInvalid" format:@"Mobile app bootstrap payload is invalid"];
      }
      NSString *rnHostAbi = [self requiredString:bootstrap key:@"rnHostAbi"];
      if (![rnHostAbi isEqualToString:expectedRnHostAbi]) {
        [NSException raise:@"NatStackRnHostAbiMismatch" format:@"React Native host ABI mismatch: expected %@, got %@", expectedRnHostAbi, rnHostAbi];
      }
      NSDictionary *artifact = [self selectArtifact:bootstrap platform:platform];
      NSString *artifactUrl = [self requiredString:artifact key:@"url"];
      [self assertArtifactURL:artifactUrl sameOriginAsServer:credential[@"serverUrl"]];
      NSData *bundleData = [self getData:artifactUrl];
      NSString *integrity = [self requiredString:artifact key:@"integrity"];
      [self verifySha256Integrity:integrity data:bundleData];
      NSString *localPath = [self writeBundleData:bundleData buildKey:[self requiredString:bootstrap key:@"buildKey"] artifactPath:[self requiredString:artifact key:@"path"]];
      if ([source isKindOfClass:[NSString class]] && source.length > 0) {
        [[NSUserDefaults standardUserDefaults] setObject:source forKey:NatStackActiveBundleSource];
      } else {
        [[NSUserDefaults standardUserDefaults] removeObjectForKey:NatStackActiveBundleSource];
      }
      NSMutableDictionary *result = [@{
        @"appId": [self requiredString:bootstrap key:@"appId"],
        @"buildKey": [self requiredString:bootstrap key:@"buildKey"],
        @"capabilities": [self requiredStringArray:bootstrap key:@"capabilities"],
        @"rnHostAbi": rnHostAbi,
        @"integrity": integrity,
        @"platform": platform,
        @"url": artifactUrl,
        @"path": [self requiredString:artifact key:@"path"],
        @"localPath": localPath,
      } mutableCopy];
      NSString *effectiveVersion = [self optionalString:bootstrap key:@"effectiveVersion"];
      if (effectiveVersion != nil) result[@"effectiveVersion"] = effectiveVersion;
      resolve(result);
    } @catch (NSException *exception) {
      reject(@"bundle_prepare_failed", exception.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(activatePreparedAppBundle:(NSString *)localPath
                  buildKey:(NSString *)buildKey
                  integrity:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSString *canonicalPath = [self validatedPreparedBundlePath:localPath];
    NSData *bundleData = [NSData dataWithContentsOfFile:canonicalPath];
    if (bundleData == nil) {
      [NSException raise:@"NatStackBundleActivationInvalid" format:@"Prepared React Native bundle could not be read"];
    }
    [self verifySha256Integrity:integrity data:bundleData];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    BOOL changed =
      ![[defaults stringForKey:NatStackActiveBundleLocalPath] isEqualToString:canonicalPath] ||
      ![[defaults stringForKey:NatStackActiveBundleBuildKey] isEqualToString:buildKey] ||
      ![[defaults stringForKey:NatStackActiveBundleIntegrity] isEqualToString:integrity];
    [defaults setObject:canonicalPath forKey:NatStackActiveBundleLocalPath];
    [defaults setObject:buildKey forKey:NatStackActiveBundleBuildKey];
    [defaults setObject:integrity forKey:NatStackActiveBundleIntegrity];
    [defaults synchronize];
    resolve(@{ @"activated": @(changed) });
    if (changed) {
      dispatch_async(dispatch_get_main_queue(), ^{
        RCTReloadCommandSetBundleURL([NSURL fileURLWithPath:canonicalPath]);
        RCTTriggerReloadCommandListeners(@"NatStack workspace app bundle activated");
      });
    }
  } @catch (NSException *exception) {
    reject(@"bundle_activate_failed", exception.reason, nil);
  }
}

- (NSDictionary *)issueGrantForCredential:(NSDictionary *)credential source:(NSString *)source
{
  NSMutableDictionary *body = [@{
    @"deviceId": credential[@"deviceId"],
    @"refreshToken": credential[@"refreshToken"],
    @"principal": @"react-native-app",
  } mutableCopy];
  if ([source isKindOfClass:[NSString class]] && source.length > 0) {
    body[@"source"] = source;
  }
  NSDictionary *response = [self postJson:credential[@"serverUrl"] path:@"/_r/s/auth/refresh-principal-grant" body:body];
  NSString *callerId = [self optionalString:response key:@"callerId"] ?: @"";
  NSString *connectionGrant = [self optionalString:response key:@"connectionGrant"] ?: @"";
  NSString *responseDeviceId = [self optionalString:response key:@"deviceId"];
  if (![self isWorkspaceMobileAppCaller:callerId deviceId:credential[@"deviceId"]]) {
    [NSException raise:@"NatStackAppGrantInvalid" format:@"Mobile app grant response did not include a workspace mobile app principal"];
  }
  if (connectionGrant.length == 0) {
    [NSException raise:@"NatStackAppGrantInvalid" format:@"Mobile app grant response did not include a connection grant"];
  }
  if (responseDeviceId.length > 0 && ![responseDeviceId isEqualToString:credential[@"deviceId"]]) {
    [NSException raise:@"NatStackAppGrantInvalid" format:@"Mobile app grant response device did not match the stored credential"];
  }
  NSMutableDictionary *result = [@{
    @"serverUrl": credential[@"serverUrl"],
    @"deviceId": credential[@"deviceId"],
    @"callerId": callerId,
    @"connectionGrant": connectionGrant,
  } mutableCopy];
  NSNumber *expiresAt = response[@"expiresAt"];
  if ([expiresAt isKindOfClass:[NSNumber class]]) result[@"expiresAt"] = expiresAt;
  NSString *serverBootId = [self optionalString:response key:@"serverBootId"];
  result[@"serverId"] = [self requiredString:response key:@"serverId"];
  if (serverBootId != nil) result[@"serverBootId"] = serverBootId;
  result[@"workspaceId"] = [self requiredString:response key:@"workspaceId"];
  return result;
}

- (NSString *)activeAppSource
{
  NSString *source = [[NSUserDefaults standardUserDefaults] stringForKey:NatStackActiveBundleSource];
  return source.length > 0 ? source : nil;
}

- (void)clearStoredCredentials
{
  [self deleteCredential];
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:NatStackActiveBundleSource];
}

- (BOOL)isWorkspaceMobileAppCaller:(NSString *)callerId deviceId:(NSString *)deviceId
{
  return [callerId hasPrefix:NatStackWorkspaceAppCallerPrefix] &&
    deviceId.length > 0 &&
    [callerId hasSuffix:[@":" stringByAppendingString:deviceId]];
}

- (NSDictionary *)postJson:(NSString *)serverUrl path:(NSString *)path body:(NSDictionary *)body
{
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@%@", serverUrl, path]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.timeoutInterval = 15;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSData *responseData = nil;
  __block NSHTTPURLResponse *httpResponse = nil;
  __block NSError *requestError = nil;
  NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    responseData = data;
    httpResponse = (NSHTTPURLResponse *)response;
    requestError = error;
    dispatch_semaphore_signal(semaphore);
  }];
  [task resume];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

  if (requestError != nil) {
    [NSException raise:@"NatStackAuthRequestFailed" format:@"%@", requestError.localizedDescription];
  }
  NSDictionary *json = @{};
  if (responseData.length > 0) {
    json = [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil] ?: @{};
  }
  if (httpResponse.statusCode < 200 || httpResponse.statusCode >= 300) {
    NSString *message = [json[@"error"] isKindOfClass:[NSString class]] ? json[@"error"] : [NSString stringWithFormat:@"Auth request failed (%ld)", (long)httpResponse.statusCode];
    [NSException raise:@"NatStackAuthRequestFailed" format:@"%@", message];
  }
  return json;
}

- (NSData *)getData:(NSString *)urlString
{
  NSURL *url = [NSURL URLWithString:urlString];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"GET";
  request.timeoutInterval = 30;

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSData *responseData = nil;
  __block NSHTTPURLResponse *httpResponse = nil;
  __block NSError *requestError = nil;
  NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    responseData = data ?: [NSData data];
    httpResponse = (NSHTTPURLResponse *)response;
    requestError = error;
    dispatch_semaphore_signal(semaphore);
  }];
  [task resume];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

  if (requestError != nil) {
    [NSException raise:@"NatStackBundleRequestFailed" format:@"%@", requestError.localizedDescription];
  }
  if (httpResponse.statusCode < 200 || httpResponse.statusCode >= 300) {
    NSString *message = [[NSString alloc] initWithData:responseData encoding:NSUTF8StringEncoding] ?: @"";
    [NSException raise:@"NatStackBundleRequestFailed" format:@"Bundle artifact request failed (%ld): %@", (long)httpResponse.statusCode, message];
  }
  return responseData ?: [NSData data];
}

- (void)assertArtifactURL:(NSString *)artifactUrl sameOriginAsServer:(NSString *)serverUrl
{
  NSURLComponents *artifact = [NSURLComponents componentsWithString:artifactUrl];
  NSURLComponents *server = [NSURLComponents componentsWithString:serverUrl];
  NSString *artifactScheme = artifact.scheme.lowercaseString ?: @"";
  NSString *serverScheme = server.scheme.lowercaseString ?: @"";
  BOOL validScheme = [artifactScheme isEqualToString:@"http"] || [artifactScheme isEqualToString:@"https"];
  BOOL sameOrigin =
    validScheme &&
    [artifactScheme isEqualToString:serverScheme] &&
    artifact.host.length > 0 &&
    [artifact.host caseInsensitiveCompare:server.host ?: @""] == NSOrderedSame &&
    [[self normalizedPortForComponents:artifact] isEqualToNumber:[self normalizedPortForComponents:server]];
  if (!sameOrigin) {
    [NSException raise:@"NatStackBundleBootstrapInvalid" format:@"React Native bundle artifact URL is outside the paired server origin"];
  }
}

- (NSDictionary *)selectArtifact:(NSDictionary *)bootstrap platform:(NSString *)platform
{
  NSArray *artifacts = bootstrap[@"artifacts"];
  if (![artifacts isKindOfClass:[NSArray class]]) {
    [NSException raise:@"NatStackBundleBootstrapInvalid" format:@"Mobile app bootstrap artifacts are invalid"];
  }
  for (id item in artifacts) {
    if (![item isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *artifact = item;
    if (![[self optionalString:artifact key:@"role"] isEqualToString:@"primary"]) continue;
    NSString *artifactPlatform = [self optionalString:artifact key:@"platform"];
    if ([artifactPlatform isEqualToString:platform]) return artifact;
  }
  [NSException raise:@"NatStackBundleBootstrapInvalid" format:@"No primary React Native bundle artifact is available for %@", platform];
  return @{};
}

- (void)verifySha256Integrity:(NSString *)integrity data:(NSData *)data
{
  NSString *expected = [integrity hasPrefix:@"sha256-"] ? [integrity substringFromIndex:@"sha256-".length] : integrity;
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"^[A-Fa-f0-9]{64}$" options:0 error:nil];
  if ([regex numberOfMatchesInString:expected options:0 range:NSMakeRange(0, expected.length)] != 1) {
    [NSException raise:@"NatStackBundleIntegrityUnsupported" format:@"Unsupported React Native bundle integrity: %@", integrity];
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *actual = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [actual appendFormat:@"%02x", digest[index]];
  }
  if ([actual caseInsensitiveCompare:expected] != NSOrderedSame) {
    [NSException raise:@"NatStackBundleIntegrityMismatch" format:@"React Native bundle integrity mismatch"];
  }
}

- (NSString *)writeBundleData:(NSData *)data buildKey:(NSString *)buildKey artifactPath:(NSString *)artifactPath
{
  NSString *safeBuildKey = [self safePathSegment:buildKey];
  NSString *safeArtifact = [self safePathSegment:artifactPath];
  NSURL *cacheURL = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  NSURL *dirURL = [[cacheURL URLByAppendingPathComponent:@"natstack-rn" isDirectory:YES] URLByAppendingPathComponent:safeBuildKey isDirectory:YES];
  [NSFileManager.defaultManager createDirectoryAtURL:dirURL withIntermediateDirectories:YES attributes:nil error:nil];
  NSURL *fileURL = [dirURL URLByAppendingPathComponent:safeArtifact isDirectory:NO];
  if (![data writeToURL:fileURL atomically:YES]) {
    [NSException raise:@"NatStackBundleCacheWriteFailed" format:@"Could not write prepared React Native bundle"];
  }
  return fileURL.path;
}

- (NSString *)validatedPreparedBundlePath:(NSString *)localPath
{
  NSString *canonicalPath = [localPath stringByResolvingSymlinksInPath];
  NSURL *cacheURL = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  NSString *bundleRoot = [[[cacheURL URLByAppendingPathComponent:@"natstack-rn" isDirectory:YES] path] stringByResolvingSymlinksInPath];
  BOOL isUnderRoot = [canonicalPath isEqualToString:bundleRoot] || [canonicalPath hasPrefix:[bundleRoot stringByAppendingString:@"/"]];
  BOOL isDirectory = NO;
  if (!isUnderRoot || ![NSFileManager.defaultManager fileExistsAtPath:canonicalPath isDirectory:&isDirectory] || isDirectory) {
    [NSException raise:@"NatStackBundleActivationInvalid" format:@"Prepared React Native bundle is outside the app cache"];
  }
  return canonicalPath;
}

- (NSString *)safePathSegment:(NSString *)value
{
  NSMutableString *out = [NSMutableString stringWithCapacity:value.length];
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"];
  for (NSUInteger index = 0; index < value.length; index++) {
    unichar ch = [value characterAtIndex:index];
    if ([allowed characterIsMember:ch]) {
      [out appendFormat:@"%C", ch];
    } else {
      [out appendString:@"_"];
    }
  }
  return out.length > 0 ? out : @"bundle";
}

- (void)saveCredential:(NSDictionary *)credential
{
  NSData *data = [NSJSONSerialization dataWithJSONObject:credential options:0 error:nil];
  [self deleteCredential];
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: NatStackKeychainService,
    (__bridge id)kSecAttrAccount: NatStackCredentialAccount,
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    (__bridge id)kSecValueData: data,
  };
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
  if (status != errSecSuccess) {
    [NSException raise:@"NatStackKeychainSaveFailed" format:@"Could not store mobile credentials (%d)", (int)status];
  }
}

- (NSDictionary *)loadCredential
{
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: NatStackKeychainService,
    (__bridge id)kSecAttrAccount: NatStackCredentialAccount,
    (__bridge id)kSecReturnData: @YES,
    (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
  };
  CFTypeRef item = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &item);
  if (status == errSecItemNotFound) return nil;
  if (status != errSecSuccess) {
    [NSException raise:@"NatStackKeychainLoadFailed" format:@"Could not load mobile credentials (%d)", (int)status];
  }
  NSData *data = (__bridge_transfer NSData *)item;
  NSDictionary *credential = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![credential isKindOfClass:[NSDictionary class]]) {
    [NSException raise:@"NatStackCredentialRepair" format:@"Stored credential payload is invalid"];
  }
  [self requiredString:credential key:@"serverUrl"];
  [self requiredString:credential key:@"deviceId"];
  [self requiredString:credential key:@"refreshToken"];
  [self requiredString:credential key:@"serverId"];
  [self requiredString:credential key:@"workspaceId"];
  return credential;
}

- (void)deleteCredential
{
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: NatStackKeychainService,
    (__bridge id)kSecAttrAccount: NatStackCredentialAccount,
  };
  SecItemDelete((__bridge CFDictionaryRef)query);
}

- (NSString *)normalizeServerUrl:(NSString *)serverUrl
{
  NSString *trimmed = [serverUrl stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSURLComponents *components = [NSURLComponents componentsWithString:trimmed];
  NSString *scheme = components.scheme.lowercaseString ?: @"";
  if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) {
    [NSException raise:@"NatStackInvalidServerURL" format:@"Pairing server URL must use http or https"];
  }
  if (components.host.length == 0 || components.user.length > 0 || components.password.length > 0) {
    [NSException raise:@"NatStackInvalidServerURL" format:@"Pairing server URL must be an origin"];
  }
  if (
    (components.path.length > 0 && ![components.path isEqualToString:@"/"]) ||
    components.query.length > 0 ||
    components.fragment.length > 0
  ) {
    [NSException raise:@"NatStackInvalidServerURL" format:@"Pairing server URL must not include a path, query, or fragment"];
  }
  components.scheme = scheme;
  components.path = @"";
  components.query = nil;
  components.fragment = nil;
  components.user = nil;
  components.password = nil;
  return components.string;
}

- (NSNumber *)normalizedPortForComponents:(NSURLComponents *)components
{
  if (components.port != nil) return components.port;
  NSString *scheme = components.scheme.lowercaseString ?: @"";
  if ([scheme isEqualToString:@"https"]) return @443;
  if ([scheme isEqualToString:@"http"]) return @80;
  return @-1;
}

- (NSString *)requiredString:(NSDictionary *)dictionary key:(NSString *)key
{
  id value = dictionary[key];
  if (![value isKindOfClass:[NSString class]] || [value length] == 0) {
    [NSException raise:@"NatStackMissingField" format:@"Missing credential field: %@", key];
  }
  return value;
}

- (NSString *)optionalString:(NSDictionary *)dictionary key:(NSString *)key
{
  id value = dictionary[key];
  if (![value isKindOfClass:[NSString class]] || [value length] == 0) return nil;
  return value;
}

- (NSArray *)requiredStringArray:(NSDictionary *)dictionary key:(NSString *)key
{
  id value = dictionary[key];
  if (![value isKindOfClass:[NSArray class]]) {
    [NSException raise:@"NatStackMissingField" format:@"Missing string array field: %@", key];
  }
  for (id item in (NSArray *)value) {
    if (![item isKindOfClass:[NSString class]] || [item length] == 0) {
      [NSException raise:@"NatStackInvalidField" format:@"Invalid string array field: %@", key];
    }
  }
  return value;
}

@end
