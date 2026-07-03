from loguru import logger

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
    OTLPSpanExporter,
)

_tracer = None


def init_tracing(
    service_name: str = "samvyo-bot",
    endpoint: str = "localhost:4317",
):
    """
    Initialize OpenTelemetry once during bot startup.
    """

    global _tracer

    resource = Resource.create(
        {
            "service.name": service_name,
        }
    )

    provider = TracerProvider(resource=resource)

    exporter = OTLPSpanExporter(
        endpoint=endpoint,
        insecure=True,
    )

    provider.add_span_processor(
        BatchSpanProcessor(exporter)
    )

    trace.set_tracer_provider(provider)

    _tracer = trace.get_tracer(service_name)

    logger.info(
        f"✅ OpenTelemetry initialized ({service_name})"
    )

    return _tracer


def get_tracer():
    """
    Return the global tracer.
    """

    global _tracer

    if _tracer is None:
        _tracer = trace.get_tracer("samvyo-bot")

    return _tracer