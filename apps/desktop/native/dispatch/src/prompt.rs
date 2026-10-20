//! 派单会话的提示词（2.x `prompt.ts`，逐字照抄）。从 stdin 写入，不上命令行；只放任务定位信息与工作守则，
//! 不放任何密钥或令牌：会话经本机已安装的 ATM MCP 接入。

#[derive(Clone, Debug)]
pub struct PromptInput<'a> {
    pub run: &'a str,
    pub project_code: &'a str,
    pub project_name: &'a str,
    pub cwd: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub mobile: bool,
    pub requested_by: Option<&'a str>,
}

/// JS `String.prototype.trim` 的空白：Unicode White_Space 加上 U+FEFF。
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// 连续的控制字符（U+0000–U+001F、U+007F）换成一个空格。
pub(crate) fn flatten_controls(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if c <= '\u{1f}' || c == '\u{7f}' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// 去掉控制字符并截断（按码点，截断时最后一位换成「…」）。
fn clean(value: &str, limit: usize) -> String {
    let flat = flatten_controls(value);
    let flat = js_trim(&flat);
    let points: Vec<char> = flat.chars().collect();
    if points.len() <= limit {
        flat.to_owned()
    } else {
        let mut s: String = points[..limit - 1].iter().collect();
        s.push('…');
        s
    }
}

/// JSON 字符串字面量：路径里的反斜杠与引号原样转义，Claude 照抄进工具参数不会出错。
fn literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

pub fn render(input: &PromptInput<'_>) -> String {
    let place = if input.mobile {
        "手机端"
    } else {
        "桌面端"
    };
    let who = input
        .requested_by
        .filter(|r| !r.is_empty())
        .map(|r| format!("（{}）", clean(r, 60)))
        .unwrap_or_default();
    let cwd = literal(input.cwd);
    let code = literal(input.project_code);
    let key = input.key;
    [
        "这是 AyanamiTaskManager（ATM）「交给 Claude」派单自动唤起的无头 Claude Code 会话，终端前没有人实时看着。".to_owned(),
        format!("用户在 ATM {place}{who}点名把下面这个任务交给你："),
        String::new(),
        format!("- 项目：{}（{}）", clean(input.project_name, 120), input.project_code),
        format!("- 任务：{key} {}", clean(input.title, 200)),
        format!("- 工作目录：{}", input.cwd),
        format!("- 派单编号：{}", input.run),
        String::new(),
        "请依次完成：".to_owned(),
        String::new(),
        format!("1. 开工：调用 atm_begin(cwd={cwd}, agent_id=\"claude-code\", client_kind=\"claude-code\", project_code={code})，直接使用返回的 brief，不要紧接着再调 atm_brief。"),
        format!("2. 领取：用 atm_task_get 读取 {key}，再用 atm_task_patch 对它执行 start（start 即领取并开工）。如果任务已被其他会话领取，或状态已不允许领取，不要抢占：调用 atm_end(outcome=\"cancelled\") 写明原因后结束。"),
        "3. 完善目标：阅读相关代码，并用 atm_search 查该任务相关的 ATM 记录与历史进度，然后用 atm_task_patch 的 edit 操作把描述改写成清晰、可执行的目标，并补齐 2～6 条可验证的验收标准；任务明显过大时用 atm_task_create 拆成子任务。".to_owned(),
        "4. 开始实现：遵守 ATM 规则，只在有意义的状态变化时用 atm_progress_add 写进度，长期决策、事实与风险用 atm_record 记下。验收标准全部满足并已自测后，用 atm_task_patch 的 verify_and_complete（或 complete）关闭任务；做不完就保持进行中，留给交接。".to_owned(),
        "5. 需要用户做决定时（需求不明确、多种方案需要取舍、需要凭据或授权），不要猜：用 atm_task_patch 的 wait_user 把任务置为 WAITING_USER，把问题写清楚，然后调用 atm_end 交接结束。".to_owned(),
        "6. 不要做发布、推送（git push）、删除数据、改动线上环境等对外或不可逆的操作，除非任务描述明确要求。".to_owned(),
        "7. 结束前调用 atm_end 交接：写清已完成的内容、还没完成的部分和下一步。".to_owned(),
        String::new(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.x `test/__snapshots__/units.test.ts.snap` 的快照原文（vitest 快照里的 `\\` 是一个反斜杠）。
    const SNAPSHOT: &str = r#"这是 AyanamiTaskManager（ATM）「交给 Claude」派单自动唤起的无头 Claude Code 会话，终端前没有人实时看着。
用户在 ATM 手机端（Pixel 9）点名把下面这个任务交给你：

- 项目：AyanamiTaskManager（ATM）
- 任务：ATM-T-0545 Claude 自动派单 （agent-dispatch）
- 工作目录：R:\Project_All\AyanamiTaskManager
- 派单编号：mg7x3k2a-1a2b3c4d

请依次完成：

1. 开工：调用 atm_begin(cwd="R:\\Project_All\\AyanamiTaskManager", agent_id="claude-code", client_kind="claude-code", project_code="ATM")，直接使用返回的 brief，不要紧接着再调 atm_brief。
2. 领取：用 atm_task_get 读取 ATM-T-0545，再用 atm_task_patch 对它执行 start（start 即领取并开工）。如果任务已被其他会话领取，或状态已不允许领取，不要抢占：调用 atm_end(outcome="cancelled") 写明原因后结束。
3. 完善目标：阅读相关代码，并用 atm_search 查该任务相关的 ATM 记录与历史进度，然后用 atm_task_patch 的 edit 操作把描述改写成清晰、可执行的目标，并补齐 2～6 条可验证的验收标准；任务明显过大时用 atm_task_create 拆成子任务。
4. 开始实现：遵守 ATM 规则，只在有意义的状态变化时用 atm_progress_add 写进度，长期决策、事实与风险用 atm_record 记下。验收标准全部满足并已自测后，用 atm_task_patch 的 verify_and_complete（或 complete）关闭任务；做不完就保持进行中，留给交接。
5. 需要用户做决定时（需求不明确、多种方案需要取舍、需要凭据或授权），不要猜：用 atm_task_patch 的 wait_user 把任务置为 WAITING_USER，把问题写清楚，然后调用 atm_end 交接结束。
6. 不要做发布、推送（git push）、删除数据、改动线上环境等对外或不可逆的操作，除非任务描述明确要求。
7. 结束前调用 atm_end 交接：写清已完成的内容、还没完成的部分和下一步。
"#;

    #[test]
    fn the_prompt_is_the_2x_template_word_for_word() {
        let prompt = render(&PromptInput {
            run: "mg7x3k2a-1a2b3c4d",
            project_code: "ATM",
            project_name: "AyanamiTaskManager",
            cwd: r"R:\Project_All\AyanamiTaskManager",
            key: "ATM-T-0545",
            title: "Claude 自动派单\n（agent-dispatch）",
            mobile: true,
            requested_by: Some("Pixel 9"),
        });
        assert_eq!(prompt, SNAPSHOT);
        let lower = prompt.to_lowercase();
        assert!(!lower.contains("token") && !lower.contains("secret") && !prompt.contains("令牌"));
        let desktop = render(&PromptInput {
            run: "r-00000000",
            project_code: "ATM",
            project_name: "A",
            cwd: "/p",
            key: "ATM-T-0001",
            title: "t",
            mobile: false,
            requested_by: None,
        });
        assert!(desktop.contains("用户在 ATM 桌面端点名"));
    }

    #[test]
    fn user_text_is_flattened_and_clipped_by_code_point() {
        assert_eq!(clean("a\u{0}\u{1}\tb\u{7f}c", 10), "a b c");
        assert_eq!(clean("  \u{feff}x\u{3000} ", 10), "x");
        let long: String = "字".repeat(130);
        let clipped = clean(&long, 120);
        assert_eq!(clipped.chars().count(), 120);
        assert!(clipped.ends_with('…'));
        assert_eq!(clean(&"字".repeat(120), 120).chars().count(), 120);
    }
}
