import { DownloadSimpleIcon as Download } from "@phosphor-icons/react/dist/icons/DownloadSimple";
import { FileArrowUpIcon as FileArrowUp } from "@phosphor-icons/react/dist/icons/FileArrowUp";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { PageHead } from "../components/async-state.js";
import { exportMarkdown, type KnowledgeForm } from "./knowledge-support.js";

export function KnowledgeActions({
  form,
  pending,
  onCreate,
  onImport,
}: {
  form: KnowledgeForm;
  pending: boolean;
  onCreate: () => void;
  onImport: (file: File) => void | Promise<void>;
}) {
  return (
    <PageHead
      title="知识库"
      description="跨项目共享的本地 Markdown 知识。正文按需读取，归档条目不会出现在默认搜索中。"
      actions={
        <>
          <button
            className="atm-button primary"
            type="button"
            disabled={pending}
            onClick={onCreate}
          >
            <Plus size={16} />
            新建
          </button>
          <label
            className="atm-button atm-knowledge-import-button"
            title="从本地 Markdown 文件创建可编辑草稿"
            aria-disabled={pending}
          >
            <FileArrowUp size={16} />
            导入 Markdown
            <input
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="atm-visually-hidden"
              disabled={pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onImport(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button
            className="atm-button"
            type="button"
            disabled={!form.title.trim() || !form.bodyMarkdown || pending}
            onClick={() => exportMarkdown(form)}
          >
            <Download size={16} />
            导出 Markdown
          </button>
        </>
      }
    />
  );
}
