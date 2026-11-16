#import "ObjCCatch.h"

BOOL PURunCatching(void (NS_NOESCAPE ^block)(void), NSError **error) {
  @try {
    block();
    return YES;
  } @catch (NSException *exception) {
    if (error) {
      NSString *reason = exception.reason ?: exception.name;
      *error = [NSError errorWithDomain:@"dev.phoneuse.runner.exception"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : reason ?: @"Objective-C exception"}];
    }
    return NO;
  }
}
