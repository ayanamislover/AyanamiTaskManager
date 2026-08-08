# ADR-012：FTS5 trigram 中文检索

状态：Accepted

项目库使用 FTS5 `trigram` 对标题、描述、更新、记录和阻塞建立 substring 索引；少于 3 字符的查询回退到带 LIMIT 的参数化 `LIKE`。启动和 doctor 必须实测 tokenizer；缺失时拒绝相应项目写入，不悄悄降级为不可用的中文分词。
