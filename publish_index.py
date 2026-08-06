from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
DEFAULT_QUERY_ENGINE = BASE.parent / "SVMS_Query_Engine"
SITE_INDEX = BASE / "data" / "stores_index.json"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="將 Query Engine 最新索引發布到 SVMS Mobile 網頁資料夾"
    )
    parser.add_argument(
        "--query-engine",
        default=str(DEFAULT_QUERY_ENGINE),
        help="SVMS Query Engine 資料夾位置",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="發布前先由 Query Engine 從 Dropbox 更新正式 Master",
    )
    args = parser.parse_args()

    query_engine = Path(args.query_engine).expanduser().resolve()
    query_script = query_engine / "query.py"
    source_index = query_engine / "cache" / "stores_index.json"

    if not query_script.exists():
        raise SystemExit(f"找不到 Query Engine：{query_script}")

    command = [sys.executable, str(query_script)]
    command.append("--refresh" if args.refresh else "--rebuild")
    subprocess.run(command, cwd=query_engine, check=True)

    if not source_index.exists():
        raise SystemExit(f"找不到索引：{source_index}")

    SITE_INDEX.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_index, SITE_INDEX)
    print(f"✅ 網頁索引已更新：{SITE_INDEX}")


if __name__ == "__main__":
    main()
