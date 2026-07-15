import re
from loguru import logger

try:
    import spacy
    SPACY_AVAILABLE = True
except ImportError:
    SPACY_AVAILABLE = False


class PIIScrubber:
    """
    Removes Personally Identifiable Information (PII)
    before sending user text to the LLM.

    Currently supports:
    - Email addresses
    - Phone numbers
    - Person names (spaCy NER)
    """

    EMAIL_REGEX = re.compile(
        r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+"
    )

    PHONE_REGEX = re.compile(
        r"(\+?\d{1,3}[-.\s]?)?"
        r"(\(?\d{2,4}\)?[-.\s]?)?"
        r"\d{3}[-.\s]?\d{4}\b"
    )

    def __init__(self):

        self.nlp = None

        if SPACY_AVAILABLE:
            try:
                self.nlp = spacy.load("en_core_web_sm")
                logger.info("✅ PII Scrubber loaded (spaCy)")
            except Exception:
                logger.warning(
                    "spaCy model not found. "
                    "Run:\n"
                    "python -m spacy download en_core_web_sm"
                )
        else:
            logger.warning(
                "spaCy is not installed. "
                "Name masking disabled."
            )

    def scrub_email(self, text: str) -> str:
        return self.EMAIL_REGEX.sub(
            "[REDACTED_EMAIL]",
            text
        )

    def scrub_phone(self, text: str) -> str:
        return self.PHONE_REGEX.sub(
            "[REDACTED_PHONE]",
            text
        )

    def scrub_names(self, text: str) -> str:

        if self.nlp is None:
            return text

        doc = self.nlp(text)

        result = text

        entities = sorted(
            doc.ents,
            key=lambda x: x.start_char,
            reverse=True
        )

        for ent in entities:

            if ent.label_ == "PERSON":

                result = (
                    result[:ent.start_char]
                    + "[REDACTED_NAME]"
                    + result[ent.end_char:]
                )

        return result

    def scrub(self, text: str) -> str:

        logger.info(f"🧪 PIIScrubber INPUT: {text}")

        if not text:
            return text

        original = text

        text = self.scrub_email(text)
        text = self.scrub_phone(text)
        text = self.scrub_names(text)

        if text != original:
            logger.info(
                f"🔒 PII Scrubbed\n"
                f"Before : {original}\n"
                f"After  : {text}"
            )

        return text