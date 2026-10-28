/* Static landing copy uses the same en/zh locale convention as the desktop app.
   Translated HTML is authored in index.html, never fetched or supplied by users. */
(function () {
  "use strict";
  var doc = document;
  var storageKey = "meldwork-landing-locale";
  var locale;
  try { locale = localStorage.getItem(storageKey); } catch (error) { /* Storage is optional. */ }
  if (locale !== "zh" && locale !== "en") {
    locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  var copies = Array.from(doc.querySelectorAll("[data-zh]")).map(function (el) {
    return { el: el, en: el.innerHTML, zh: el.dataset.zh };
  });
  var labels = {
    "Agent activity": "Agent 协作状态",
    "Meldwork home": "Meldwork 首页", "Primary": "主导航", "Mobile": "移动端导航",
    "Toggle theme": "切换明暗主题", "Menu": "菜单", "Playback mode": "播放模式",
    "Previous step": "上一步", "Next step": "下一步", "Scroll to workflow": "查看工作流程",
    "Meldwork detecting local Agent CLIs": "Meldwork 检测本地 Agent CLI",
    "Agents discussing and reviewing a shared task": "Agent 讨论并检查同一个任务",
    "Auto Discussion group collaboration": "自动讨论 群组协作",
    "Direct multimodal session with local files": "引用本地文件的多模态直接会话"
  };
  var attributes = [];
  doc.querySelectorAll("[aria-label], img[alt]").forEach(function (el) {
    ["aria-label", "alt"].forEach(function (name) {
      var original = el.getAttribute(name);
      if (labels[original]) attributes.push({ el: el, name: name, en: original, zh: labels[original] });
    });
  });
  var meta = Array.from(doc.querySelectorAll('meta[name="description"], meta[name="keywords"], meta[property="og:title"], meta[property="og:description"], meta[name="twitter:title"], meta[name="twitter:description"]'))
    .map(function (el) { return { el: el, en: el.content }; });
  var englishTitle = doc.title;
  var readmeLink = doc.querySelector('a[href="https://github.com/Ryder-Sun/Meldwork#readme"]');
  var chineseTitle = "Meldwork — 提出目标，让 Agent 们协作完成。";
  var chineseDescription = "Meldwork 是本地优先的多 Agent 协作工作空间。让你已有的 Agent 共享上下文、讨论方案、执行授权工作并检查成果，减少人工协调；需要补充信息或关键决策时再由你介入。";
  var schemaEl = doc.querySelector('script[type="application/ld+json"]');
  var englishSchema = JSON.parse(schemaEl.textContent);
  var faq = Array.from(doc.querySelectorAll(".acc-item"));
  var runtimeCopy = {
    "Waiting": "等待", "Thinking": "思考中", "Working": "运行中", "Done": "已完成",
    "Task": "任务", "Round 1 · Request": "第 1 轮 · 请求协作",
    "Round 1 · Analysis": "第 1 轮 · 分析", "Round 1 · Review": "第 1 轮 · 评审",
    "Round 2 · Synthesis": "第 2 轮 · 汇总",
    "Codex is working…": "Codex 正在分析…", "Hermes and OpenCodeReview are working…": "Hermes 和 OpenCodeReview 正在协作…",
    "Hermes and OpenCodeReview are thinking…": "Hermes 和 OpenCodeReview 正在思考…",
    "OpenCodeReview is working…": "OpenCodeReview 正在评审…", "Codex is bringing the feedback together…": "Codex 正在汇总反馈…",
    "Pause": "暂停播放", "Resume": "继续播放", "Replay": "重新播放",
    "Auto": "自动播放", "Sequence": "完整记录"
  };

  function t(english) { return locale === "zh" ? runtimeCopy[english] || english : english; }

  function setLocale(value, remember) {
    locale = value === "zh" ? "zh" : "en";
    doc.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    copies.forEach(function (copy) {
      copy.el.innerHTML = copy[locale];
      if (copy.el.matches("[data-decrypt], .eyebrow")) {
        copy.el.dataset.text = copy.el.textContent;
        copy.el.classList.remove("is-scrambling");
      }
    });
    attributes.forEach(function (copy) { copy.el.setAttribute(copy.name, copy[locale]); });
    doc.title = locale === "zh" ? chineseTitle : englishTitle;
    meta.forEach(function (copy) {
      var key = copy.el.getAttribute("name") || copy.el.getAttribute("property");
      copy.el.content = locale === "en" ? copy.en : key.includes("title") ? chineseTitle
        : key === "keywords" ? "多 Agent 协作,自主协作,本地优先,共享上下文,授权执行,Meldwork" : chineseDescription;
    });
    var schema = JSON.parse(JSON.stringify(englishSchema));
    if (locale === "zh") {
      var app = schema["@graph"].find(function (entry) { return entry["@type"] === "SoftwareApplication"; });
      app.description = chineseDescription;
      app.featureList = "自主协作、共享任务上下文、同伴贡献与评审、授权执行、并发回复、自动讨论、本地协作记录";
      app.inLanguage = "zh-CN";
      var questions = schema["@graph"].find(function (entry) { return entry["@type"] === "FAQPage"; });
      questions.mainEntity = faq.map(function (el) {
        return { "@type": "Question", name: el.querySelector(".acc-trigger").textContent.trim(),
          acceptedAnswer: { "@type": "Answer", text: el.querySelector(".acc-panel").textContent.trim() } };
      });
    }
    schemaEl.textContent = JSON.stringify(schema);
    var toggle = doc.getElementById("languageToggle");
    toggle.textContent = locale === "zh" ? "EN" : "中文";
    toggle.setAttribute("aria-label", locale === "zh" ? "Switch to English" : "切换为中文");
    toggle.setAttribute("lang", locale === "zh" ? "en" : "zh-CN");
    readmeLink.href = locale === "zh"
      ? "https://github.com/Ryder-Sun/Meldwork/blob/main/README.zh-CN.md"
      : "https://github.com/Ryder-Sun/Meldwork#readme";
    window.meldworkI18n.locale = locale;
    if (remember !== false) {
      try { localStorage.setItem(storageKey, locale); } catch (error) { /* Storage is optional. */ }
    }
    doc.dispatchEvent(new CustomEvent("meldwork:localechange"));
  }
  window.meldworkI18n = { locale: locale, t: t, setLocale: setLocale };
  doc.getElementById("languageToggle").addEventListener("click", function () {
    setLocale(locale === "zh" ? "en" : "zh");
  });
  setLocale(locale, false);
})();
