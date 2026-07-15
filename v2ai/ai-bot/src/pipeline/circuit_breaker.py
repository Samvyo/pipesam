import time
from loguru import logger


class CircuitBreaker:
    """
    Opens after N consecutive failures.
    While OPEN, Claude requests are skipped.
    After recovery_timeout seconds,
    one request is allowed again.
    """

    def __init__(
        self,
        failure_threshold: int = 3,
        recovery_timeout: int = 30,
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout

        self.failure_count = 0
        self.last_failure_time = None

        self.state = "CLOSED"

    def allow_request(self) -> bool:

        if self.state == "CLOSED":
            return True

        if self.state == "OPEN":

            elapsed = time.time() - self.last_failure_time

            if elapsed >= self.recovery_timeout:
                logger.info("🟡 Circuit HALF_OPEN")
                self.state = "HALF_OPEN"
                return True

            return False

        return True

    def record_success(self):

        if self.state != "CLOSED":
            logger.info("🟢 Circuit CLOSED")

        self.failure_count = 0
        self.state = "CLOSED"

    def record_failure(self):

        self.failure_count += 1
        self.last_failure_time = time.time()

        logger.warning(
            f"Circuit failure {self.failure_count}/{self.failure_threshold}"
        )

        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"

            logger.error(
                "🔴 Circuit OPEN - Claude temporarily disabled"
            )