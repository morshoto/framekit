import type { ReactNode } from "react";

export default function JapaneseLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div lang="ja">{children}</div>;
}
