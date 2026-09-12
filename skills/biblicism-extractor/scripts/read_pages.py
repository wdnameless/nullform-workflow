from __future__ import annotations

import argparse
from pathlib import Path
import sys


def read_pdf(path: Path, start: int, end: int) -> list[str]:
    from PyPDF2 import PdfReader

    reader = PdfReader(str(path))
    total = len(reader.pages)
    start = max(1, start)
    end = min(end, total)
    chunks: list[str] = [
        f"--- INFO: Total pages in PDF: {total}. Reading from {start} to {end}. ---"
    ]
    for page_number in range(start, end + 1):
        text = (
            reader.pages[page_number - 1].extract_text()
            or "<пустая страница или картинка>"
        )
        chunks.append(f"[PAGE {page_number}]")
        chunks.append(text)
    return chunks


def read_docx(path: Path, start: int, end: int) -> list[str]:
    import docx

    doc = docx.Document(str(path))
    paragraphs = [p.text.strip() for p in doc.paragraphs]
    total = len(paragraphs)
    start = max(1, start)
    end = min(end, total)
    chunks: list[str] = [
        f"--- INFO: Total paragraphs in DOCX: {total}. Reading from {start} to {end}. ---"
    ]
    for i in range(start - 1, end):
        text = paragraphs[i]
        if text:
            chunks.append(f"[PARAGRAPH {i + 1}] {text}")
    return chunks


def read_text(path: Path, start: int, end: int) -> list[str]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    start = max(1, start)
    end = min(end, total)
    chunks: list[str] = [
        f"--- INFO: Total lines in TXT: {total}. Reading from {start} to {end}. ---"
    ]
    for i in range(start - 1, end):
        line = lines[i].strip()
        if line:
            chunks.append(f"[LINE {i + 1}] {line}")
    return chunks


def read_excel(path: Path, start: int, end: int) -> list[str]:
    import pandas as pd

    sheets = pd.read_excel(str(path), sheet_name=None, header=None)
    rows: list[str] = []
    for sheet_name, frame in sheets.items():
        for row_index, row in frame.fillna("").astype(str).iterrows():
            values = [cell.strip() for cell in row.tolist() if cell.strip()]
            if values:
                rows.append(
                    f"[SHEET {sheet_name} ROW {row_index + 1}] {' | '.join(values)}"
                )
    total = len(rows)
    start = max(1, start)
    end = min(end, total)
    chunks: list[str] = [
        f"--- INFO: Total rows in workbook: {total}. Reading from {start} to {end}. ---"
    ]
    for i in range(start - 1, end):
        chunks.append(rows[i])
    return chunks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    path = Path(args.file)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        output = read_pdf(path, args.start, args.end)
    elif suffix == ".docx":
        output = read_docx(path, args.start, args.end)
    elif suffix in {".xls", ".xlsx"}:
        output = read_excel(path, args.start, args.end)
    elif suffix == ".txt":
        output = read_text(path, args.start, args.end)
    else:
        raise SystemExit("Unsupported extension. Use pdf, docx, xls, xlsx, or txt.")

    text = "\n".join(output)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(f"OK: {out_path}")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)


if __name__ == "__main__":
    main()
