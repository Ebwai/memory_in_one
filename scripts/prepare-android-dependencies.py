"""Extract pinned Android libraries without changing their class implementations."""
import io
import sys
import zipfile
from pathlib import Path

base = Path(sys.argv[1])
for name in ['sqlite', 'support-sqlite']:
    with zipfile.ZipFile(base / (name + '.aar')) as source:
        (base / (name + '.jar')).write_bytes(source.read('classes.jar'))
        if name == 'sqlite':
            for item in source.namelist():
                if item.startswith('jni/') and item.endswith('.so'):
                    target = base / 'native' / 'lib' / item[4:]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read(item))
# The SQLite binding only uses these AndroidX Core types. Preserve original
# bytecode and license notices instead of shipping unrelated Android UI classes.
with zipfile.ZipFile(base / 'androidx-core.aar') as archive:
    with zipfile.ZipFile(io.BytesIO(archive.read('classes.jar'))) as classes:
        with zipfile.ZipFile(base / 'cancellation.jar', 'w', zipfile.ZIP_DEFLATED) as result:
            for item in classes.namelist():
                if item.startswith(('androidx/core/os/CancellationSignal', 'androidx/core/os/OperationCanceledException', 'META-INF/')):
                    result.writestr(item, classes.read(item))
