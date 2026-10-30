# UGREEN Central Iowa SMART reporter. Runs on the UGOS box; reads SMART on the host over SSH
# (see README.md) and reports to the bot. Build from this folder:
#   docker build -t central-iowa-smart:latest deploy/ugreen-smart
FROM debian:stable-slim

# Only what the reporter needs: Python, the SSH client, CA roots for the bot's HTTPS, and zone
# data for the America/Chicago schedule. Nothing here is installed on the UGOS host.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 openssh-client ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --no-create-home --home-dir /app smart \
  && mkdir -p /reports && chown smart /reports
WORKDIR /app
COPY smart_report.py host/central-iowa-smart-report.sh /app/

ENV TZ=America/Chicago \
    PYTHONUNBUFFERED=1 \
    SMART_REPORT_DIR=/reports
VOLUME ["/reports"]
USER smart

# Default: run once at start, then daily at SMART_SCHEDULE (03:17 America/Chicago).
# One-off: docker run ... central-iowa-smart once --dry-run
ENTRYPOINT ["python3", "/app/smart_report.py"]
CMD ["loop"]
