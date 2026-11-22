"""Keep unit tests away from the real runtime logs."""

import os
import tempfile

os.environ.setdefault("ST_LOG_DIR", tempfile.mkdtemp(prefix="speech-trans-tests-"))
