// Input-only adapter around SimDeck's MIT-licensed native bridge. See simdeck/LICENSE.
#import "simdeck/DFPrivateSimulatorDisplayBridge.h"
#import <unistd.h>

static int failed(NSError *error) {
    fprintf(stderr, "%s\n", (error.localizedDescription ?: @"Simulator input failed").UTF8String);
    return 1;
}
static int runInput(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return 2;
        NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSError *error = nil;
        NSDictionary *input = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if (![input isKindOfClass:NSDictionary.class]) return failed(error);
        DFPrivateSimulatorDisplayBridge *bridge = [[DFPrivateSimulatorDisplayBridge alloc]
            initWithUDID:[NSString stringWithUTF8String:argv[1]] attachDisplay:NO error:&error];
        if (!bridge) return failed(error);
        // SimDeck uses USB HID usages and its own modifier bits (not macOS keycodes).
        NSString *button = input[@"button"];
        if ([button isEqualToString:@"home"]) {
            if (![bridge pressHomeButton:&error]) return failed(error);
        } else if ([button isEqualToString:@"return"]) {
            if (![bridge sendKeyCode:40 modifiers:0 error:&error]) return failed(error);
        } else if ([button isEqualToString:@"paste"]) {
            if (![bridge sendKeyCode:25 modifiers:(1 << 3) error:&error]) return failed(error);
        } else {
            double w = [input[@"width"] doubleValue], h = [input[@"height"] doubleValue];
            if (w <= 0 || h <= 0 || w > 10000 || h > 10000) return 2;
            [bridge updateInputDisplaySize:CGSizeMake(w, h)];
            double x = [input[@"start"][@"x"] doubleValue], y = [input[@"start"][@"y"] doubleValue];
            if (![bridge sendTouchAtNormalizedX:x normalizedY:y phase:DFPrivateSimulatorTouchPhaseBegan error:&error]) return failed(error);
            NSDictionary *end = input[@"end"];
            if (end) {
                double ex = [end[@"x"] doubleValue], ey = [end[@"y"] doubleValue];
                int ms = MIN(2000, MAX(50, [input[@"durationMs"] intValue]));
                int steps = MAX(2, ms / 16);
                for (int i = 1; i <= steps; i++) {
                    usleep((useconds_t)(ms * 1000 / steps));
                    if (![bridge sendTouchAtNormalizedX:x+(ex-x)*i/steps normalizedY:y+(ey-y)*i/steps
                        phase:DFPrivateSimulatorTouchPhaseMoved error:&error]) {
                        [bridge sendTouchAtNormalizedX:x normalizedY:y phase:DFPrivateSimulatorTouchPhaseCancelled error:NULL];
                        return failed(error);
                    }
                }
                x = ex; y = ey;
            } else { usleep(50000); }
            if (![bridge sendTouchAtNormalizedX:x normalizedY:y phase:DFPrivateSimulatorTouchPhaseEnded error:&error]) return failed(error);
        }
        [bridge disconnect];
        puts("ok");
        return 0;
    }
}

int main(int argc, const char *argv[]) {
    // SimulatorKit dispatches initialization to the main queue. Keep it running.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        exit(runInput(argc, argv));
    });
    dispatch_main();
}
