#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Deliver one touch gesture straight to XCTest's event synthesizer.
///
/// The public XCUICoordinate APIs wrap every gesture in "wait for the app to
/// idle" checks before and after it, which costs hundreds of milliseconds per
/// tap on screens with animations. The runner does its own settle check
/// instead, so it only needs the event itself.
///
/// `points` is a list of `@[x, y, offsetSeconds]` triples: touch down at the
/// first, move through the middle ones, lift at the last. Returns NO and fills
/// `error` when the synthesizer is unavailable in this Xcode (callers then use
/// the public API) or the gesture failed.
FOUNDATION_EXPORT BOOL PUSynthesizeTouchPath(NSArray<NSArray<NSNumber *> *> *points,
                                             NSInteger interfaceOrientation,
                                             NSTimeInterval timeout,
                                             NSError *_Nullable *_Nullable error);

/// YES when this Xcode's XCTest exposes the classes PUSynthesizeTouchPath needs.
FOUNDATION_EXPORT BOOL PUFastInputAvailable(void);

NS_ASSUME_NONNULL_END
