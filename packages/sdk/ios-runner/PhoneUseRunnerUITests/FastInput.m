#import "FastInput.h"

#import <CoreGraphics/CoreGraphics.h>
#import <XCTest/XCTest.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSString *const PUFastInputDomain = @"dev.phoneuse.runner.fastinput";

static NSError *PUFastInputError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:PUFastInputDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

BOOL PUFastInputAvailable(void) {
  Class pathClass = NSClassFromString(@"XCPointerEventPath");
  Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
  if (!pathClass || !recordClass) return NO;
  if (![pathClass instancesRespondToSelector:sel_registerName("initForTouchAtPoint:offset:")]) return NO;
  if (![pathClass instancesRespondToSelector:sel_registerName("moveToPoint:atOffset:")]) return NO;
  if (![pathClass instancesRespondToSelector:sel_registerName("liftUpAtOffset:")]) return NO;
  if (![recordClass instancesRespondToSelector:sel_registerName("initWithName:interfaceOrientation:")]) return NO;
  if (![recordClass instancesRespondToSelector:sel_registerName("addPointerEventPath:")]) return NO;
  return [XCUIDevice.sharedDevice respondsToSelector:sel_registerName("eventSynthesizer")];
}

BOOL PUSynthesizeTouchPath(NSArray<NSArray<NSNumber *> *> *points, NSInteger interfaceOrientation,
                           NSTimeInterval timeout, NSError **error) {
  if (points.count < 2) {
    if (error) *error = PUFastInputError(2, @"a touch path needs at least a down and a lift point");
    return NO;
  }
  if (!PUFastInputAvailable()) {
    if (error) *error = PUFastInputError(1, @"event synthesizer unavailable in this Xcode");
    return NO;
  }

  CGPoint (^pointAt)(NSUInteger) = ^CGPoint(NSUInteger index) {
    NSArray<NSNumber *> *p = points[index];
    return CGPointMake(p[0].doubleValue, p[1].doubleValue);
  };
  double (^offsetAt)(NSUInteger) = ^double(NSUInteger index) {
    return points[index].count > 2 ? points[index][2].doubleValue : 0;
  };

  id (*initTouch)(id, SEL, CGPoint, double) = (id(*)(id, SEL, CGPoint, double))objc_msgSend;
  void (*moveTo)(id, SEL, CGPoint, double) = (void (*)(id, SEL, CGPoint, double))objc_msgSend;
  void (*liftAt)(id, SEL, double) = (void (*)(id, SEL, double))objc_msgSend;
  id (*initRecord)(id, SEL, id, long long) = (id(*)(id, SEL, id, long long))objc_msgSend;
  void (*addPath)(id, SEL, id) = (void (*)(id, SEL, id))objc_msgSend;
  id (*getter)(id, SEL) = (id(*)(id, SEL))objc_msgSend;

  id path = initTouch([NSClassFromString(@"XCPointerEventPath") alloc], sel_registerName("initForTouchAtPoint:offset:"),
                      pointAt(0), offsetAt(0));
  NSUInteger last = points.count - 1;
  for (NSUInteger i = 1; i <= last; i++) {
    CGPoint previous = pointAt(i - 1);
    CGPoint current = pointAt(i);
    if (!CGPointEqualToPoint(previous, current)) {
      moveTo(path, sel_registerName("moveToPoint:atOffset:"), current, offsetAt(i));
    }
  }
  liftAt(path, sel_registerName("liftUpAtOffset:"), offsetAt(last));

  id record = initRecord([NSClassFromString(@"XCSynthesizedEventRecord") alloc],
                         sel_registerName("initWithName:interfaceOrientation:"), @"phone-use gesture",
                         (long long)interfaceOrientation);
  addPath(record, sel_registerName("addPointerEventPath:"), path);

  id synthesizer = getter(XCUIDevice.sharedDevice, sel_registerName("eventSynthesizer"));
  SEL synthesize = sel_registerName("synthesizeEvent:completion:");
  if (!synthesizer || ![synthesizer respondsToSelector:synthesize]) {
    if (error) *error = PUFastInputError(1, @"event synthesizer does not respond to synthesizeEvent:completion:");
    return NO;
  }

  __block BOOL finished = NO;
  __block BOOL succeeded = NO;
  __block NSError *failure = nil;
  void (*send)(id, SEL, id, id) = (void (*)(id, SEL, id, id))objc_msgSend;
  send(synthesizer, synthesize, record, ^(BOOL result, NSError *err) {
    succeeded = result;
    failure = err;
    finished = YES;
  });

  // The completion can arrive on the main queue, which this thread owns, so
  // spin the run loop rather than blocking on a semaphore.
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!finished && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  }
  if (!finished) {
    if (error) *error = PUFastInputError(3, @"gesture did not complete before the timeout");
    return NO;
  }
  if (!succeeded) {
    if (error) *error = failure ?: PUFastInputError(4, @"the event synthesizer reported failure");
    return NO;
  }
  return YES;
}
