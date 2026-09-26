"use strict";

// 优先级恢复：复用单次重组表单（预期长度 + 分片，含优先级列），
// 调用 /api/reassemble-priority，逐字节按最高优先级裁决并展示裁决依据。
// 复用 app.js 中的全局函数：parseOffset / parsePriority / collectSingleFragments /
// hexOff / fmtRange / fillRangeList / addStat / renderBar / renderPreview / hexByteLen
// （app.js 先于本文件加载）。

const PRIO_LIST_LIMIT = 400;

const prioEls = {
  submit: document.getElementById("prioSubmit"),
  resultCard: document.getElementById("prioResultCard"),
  banner: document.getElementById("prioBanner"),
  stats: document.getElementById("prioStats"),
  sourceCount: document.getElementById("prioSourceCount"),
  sourceList: document.getElementById("prioSourceList"),
  conflictCount: document.getElementById("prioConflictCount"),
  conflictList: document.getElementById("prioConflictList"),
  conflictSamples: document.getElementById("prioConflictSamples"),
  gapCount: document.getElementById("prioGapCount"),
  gapList: document.getElementById("prioGapList"),
  fragBody: document.querySelector("#prioFragTable tbody"),
  downloadBtn: document.getElementById("prioDownloadBtn"),
  downloadNote: document.getElementById("prioDownloadNote"),
};

prioEls.submit.addEventListener("click", () => {
  els.error.hidden = true;
  let expected, fragments;
  try {
    expected = parseOffset(els.expectedLength.value, "预期字节数");
    fragments = collectSingleFragments(expected, true);
  } catch (e) {
    showError(e.message);
    return;
  }

  prioEls.submit.disabled = true;
  prioEls.submit.textContent = "裁决中…";
  fetch("/api/reassemble-priority", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_length: expected, fragments }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderPriority(expected, body, fragments);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      prioEls.submit.disabled = false;
      prioEls.submit.textContent = "优先级恢复";
    });
});

// 裁决来源区间列表：[start, end) ｜ 分片 #k（优先级 p）
function renderSourceRuns(runs) {
  const ul = prioEls.sourceList;
  ul.innerHTML = "";
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "暂无唯一裁决的字节（全部位置为缺口或未决冲突）";
    ul.appendChild(li);
    return;
  }
  runs.slice(0, PRIO_LIST_LIMIT).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${fmtRange([r.start, r.end])} ｜ 分片 #${r.fragment}（优先级 ${r.priority}）`;
    li.title = `十进制 [${r.start}, ${r.end})，来源分片 #${r.fragment}`;
    ul.appendChild(li);
  });
  if (runs.length > PRIO_LIST_LIMIT) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `… 其余 ${runs.length - PRIO_LIST_LIMIT} 个区间已省略`;
    ul.appendChild(li);
  }
}

function renderPriority(expected, r, submitted) {
  prioEls.resultCard.hidden = false;
  prioEls.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const dlBtn = prioEls.downloadBtn;
  const note = prioEls.downloadNote;
  dlBtn.hidden = true;

  if (r.downloadable) {
    prioEls.banner.className = "banner ok";
    prioEls.banner.textContent =
      `✓ 全部 ${expected} 字节均有唯一裁决（无缺口、无未决冲突），可以下载还原的二进制。`;
  } else {
    const problems = [];
    if (!r.complete) problems.push(`存在 ${r.gaps.length} 段缺口（共 ${r.stats.gap_length} 字节）`);
    if (r.has_conflict) {
      problems.push(`存在 ${r.conflicts.length} 段未决冲突（共 ${r.stats.conflict_length} 字节同级异值）`);
    }
    prioEls.banner.className = "banner bad";
    prioEls.banner.textContent = "✗ 不可下载：" + problems.join("；") + "。";
  }

  // 统计：含裁决依据（压制 / 越级 / 去重计数）
  prioEls.stats.innerHTML = "";
  const s = r.stats;
  [
    ["分片数", s.fragment_count],
    ["输入字节总量", s.total_input_bytes],
    ["已覆盖字节", `${s.covered_length} / ${expected}`, r.complete ? "ok" : "warn"],
    ["缺口字节", s.gap_length, s.gap_length ? "bad" : "ok"],
    ["未决冲突字节", s.conflict_length, s.conflict_length ? "bad" : "ok"],
    ["同级同值去重字节", s.duplicate_bytes],
    ["低优先级被忽略写入", s.suppressed_write_count, s.suppressed_write_count ? "warn" : ""],
    ["高优先级取代写入", s.override_write_count, s.override_write_count ? "warn" : ""],
    ["分片是否按序到达", r.in_order ? "是" : "否（乱序）", r.in_order ? "ok" : "warn"],
  ].forEach(([k, v, cls]) => prioEls.stats.appendChild(addStat(k, v, cls)));

  renderBar(expected, r.coverage, r.conflicts, "prioCoverageBar", "prioBarHint");

  prioEls.sourceCount.textContent = `（${r.source_runs.length} 段）`;
  prioEls.conflictCount.textContent = `（${r.conflicts.length} 段）`;
  prioEls.gapCount.textContent = `（${r.gaps.length} 段）`;
  renderSourceRuns(r.source_runs);
  fillRangeList(prioEls.conflictList, r.conflicts, "无未决冲突", PRIO_LIST_LIMIT);
  fillRangeList(prioEls.gapList, r.gaps, "无缺口，[0, 预期长度) 全覆盖", PRIO_LIST_LIMIT);

  // 未决冲突取值抽样：标明发生冲突的优先级与收到的不同值
  prioEls.conflictSamples.innerHTML = "";
  r.conflict_samples.forEach((sm) => {
    const line = document.createElement("div");
    line.className = "sample-line";
    const vals = sm.values.map((v) => v.toString(16).padStart(2, "0")).join(" ≠ ");
    line.textContent =
      `偏移 ${sm.offset} (${hexOff(sm.offset)})：最高优先级 ${sm.priority} 下收到过 ${vals}`;
    prioEls.conflictSamples.appendChild(line);
  });
  if (r.conflict_samples_truncated) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = "未决冲突位置过多，仅展示前若干个位置的取值。";
    prioEls.conflictSamples.appendChild(more);
  }

  // 分片表（含优先级）
  prioEls.fragBody.innerHTML = "";
  r.fragments.forEach((f, i) => {
    const tr = document.createElement("tr");
    const clientLen = hexByteLen(submitted[i].data);
    tr.innerHTML = `<td>${f.index}</td><td><code>${f.offset} (${hexOff(f.offset)})</code></td>
      <td><code>${f.priority}</code></td>
      <td>${f.length}${clientLen !== f.length ? " (输入解析异常!)" : ""}</td>
      <td><code>[${f.offset}, ${f.end})</code></td>`;
    prioEls.fragBody.appendChild(tr);
  });

  renderPreview(expected, r.preview_hex || "", r.preview_truncated, r.conflicts, "prioPreview");

  if (r.downloadable) {
    dlBtn.hidden = false;
    note.textContent = `下载内容为按优先级裁决后的 ${expected} 字节原始二进制。`;
    dlBtn.onclick = () => {
      window.location.href = r.download_url;
    };
  } else {
    note.textContent = "仅当全部字节都有唯一裁决（无缺口、无未决冲突）时才提供下载。";
  }
}
