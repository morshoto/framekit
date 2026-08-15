#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>

@class FCPXSequence;
@class FCPXProject;
@class FCPXTimeline;

@protocol FCPXTimelineObserver <NSObject>
@optional
- (void)activeSequenceChanged;
- (void)playheadTimeChanged;
- (void)sequenceTimeRangeChanged;
@end

@interface FCPXObject : NSObject
@property(nonatomic, readonly) FCPXObject * _Nullable container;
@property(nonatomic, readonly) NSString *name;
@end

@interface FCPXSequence : FCPXObject
@property(nonatomic, readonly) CMTime startTime;
@property(nonatomic, readonly) CMTime duration;
@property(nonatomic, readonly) CMTime frameDuration;
@end

@interface FCPXProject : FCPXObject
@property(nonatomic, readonly) NSString *uid;
@property(nonatomic, readonly) FCPXSequence *sequence;
@end

@interface FCPXTimeline : NSObject
@property(nonatomic, readonly) FCPXSequence * _Nullable activeSequence;
@property(nonatomic, readonly) CMTimeRange sequenceTimeRange;
- (CMTime)playheadTime;
- (void)addTimelineObserver:(id<FCPXTimelineObserver>)observer NS_SWIFT_NAME(add(_:));
- (void)removeTimelineObserver:(id<FCPXTimelineObserver>)observer NS_SWIFT_NAME(remove(_:));
- (CMTime)movePlayheadTo:(CMTime)time NS_SWIFT_NAME(movePlayhead(to:));
@end

@interface FCPXHost : NSObject
@property(nonatomic, readonly) NSString *name;
@property(nonatomic, readonly) NSString *bundleIdentifier;
@property(nonatomic, readonly) NSString *versionString;
@property(nonatomic, readonly) FCPXTimeline * _Nullable timeline;
@end

FOUNDATION_EXPORT id<NSObject> ProExtensionHostSingleton(void);
