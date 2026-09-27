import { languageLabel, normalizeLanguageCode } from "../lib/languages";
import type { Folder } from "../types";

/**
 * Folder picker; "" means no folder. With `language`, only that language's folders are offered;
 * otherwise folders are grouped by language.
 */
export function FolderSelect({
  folders,
  value,
  onChange,
  language,
}: {
  folders: Folder[];
  value: string;
  onChange: (folderId: string) => void;
  language?: string;
}) {
  const groups = new Map<string, Folder[]>();
  for (const f of folders) {
    const code = normalizeLanguageCode(f.language ?? undefined) ?? "";
    if (language !== undefined && code !== normalizeLanguageCode(language)) continue;
    groups.set(code, [...(groups.get(code) ?? []), f]);
  }
  const options = (list: Folder[]) =>
    list.map((f) => (
      <option key={f.id} value={f.id}>
        {f.name}
      </option>
    ));

  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No folder</option>
      {language !== undefined
        ? options([...groups.values()].flat())
        : [...groups.entries()]
            .sort(([a], [b]) => languageLabel(a || undefined).localeCompare(languageLabel(b || undefined)))
            .map(([code, list]) => (
              <optgroup key={code} label={code ? languageLabel(code) : "Other"}>
                {options(list)}
              </optgroup>
            ))}
    </select>
  );
}
