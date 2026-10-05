# Issue tracker: GitHub

Storefront 的工作項目與規格記錄在 `CarlLee1983/Storefront` 的 GitHub Issues。使用 `gh` 讀取與操作。

## 常用操作

- 讀取：`gh issue view <number> --json title,body,comments,labels,state,url`
- 列出：`gh issue list --state open --json number,title,labels,url`
- 建立、留言、編輯或關閉：使用對應的 `gh issue` 指令，並遵守當次工作的寫入授權。
- ISSUE 與 PR 共用編號；遇到不明的 `#<number>`，先用 `gh pr view` 判斷，再用 `gh issue view`。

## Pull requests as a triage surface

**PRs as a request surface: no.** 外部 PR 不進入 triage 待辦清單。

當 skill 要求「publish to the issue tracker」時建立 GitHub ISSUE；要求「fetch the relevant ticket」時讀取對應 ISSUE 與留言。
