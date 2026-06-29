import time
from av import VideoFrame


class FrameSampler:

    def __init__(self, fps: int = 1):
        # Sample once every 'interval' seconds
        self.interval = 1.0 / fps
        self.last_sample_time = 0.0

    def sample(self, frame: VideoFrame):

        now = time.time()

        # Not enough time has passed
        if now - self.last_sample_time < self.interval:
            return None

        # Update sample time
        self.last_sample_time = now

        return frame