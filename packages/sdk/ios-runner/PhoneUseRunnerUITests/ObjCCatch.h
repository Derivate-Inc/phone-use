#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// XCTest raises Objective-C exceptions for some failures (for example an
/// element that vanished mid-query). Swift cannot catch those, and an uncaught
/// one ends the serving test, which kills every session on the simulator.
/// `PURunCatching` runs a block and turns any NSException into an NSError.
FOUNDATION_EXPORT BOOL PURunCatching(void (NS_NOESCAPE ^block)(void), NSError *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
