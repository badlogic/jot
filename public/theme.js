// Inline theme init - runs before page renders to avoid flash
(function() {
  var saved = localStorage.getItem("md_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);

  var sunSvg = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="8" y1="1" x2="8" y2="2.5"/><line x1="8" y1="13.5" x2="8" y2="15"/><line x1="1" y1="8" x2="2.5" y2="8"/><line x1="13.5" y1="8" x2="15" y2="8"/><line x1="3.05" y1="3.05" x2="4.1" y2="4.1"/><line x1="11.9" y1="11.9" x2="12.95" y2="12.95"/><line x1="3.05" y1="12.95" x2="4.1" y2="11.9"/><line x1="11.9" y1="4.1" x2="12.95" y2="3.05"/></g></svg>';
  var moonSvg = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M14 9.2A5.8 5.8 0 0 1 6.8 2 6.5 6.5 0 1 0 14 9.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  window.__themeIcon = function(theme) {
    return theme === "dark" ? sunSvg : moonSvg;
  };

  window.__toggleTheme = function() {
    var current = document.documentElement.getAttribute("data-theme") || "dark";
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("md_theme", next);
    var buttons = document.querySelectorAll(".theme-toggle");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].innerHTML = window.__themeIcon(next);
    }
    if (window.__mermaid) {
      window.__mermaid.initialize({ startOnLoad: false, theme: next === "light" ? "default" : "dark" });
      var container = document.getElementById("previewContent");
      if (container) {
        container.querySelectorAll(".mermaid-wrap").forEach(function(wrap) {
          var pre = wrap.querySelector("pre.mermaid");
          if (pre) { pre.textContent = pre.getAttribute("data-original-code") || ""; wrap.replaceWith(pre); }
          else { wrap.remove(); }
        });
        if (window.__renderMermaid) window.__renderMermaid(container);
      }
    }
  };

  document.addEventListener("click", function(event) {
    if (event.target.closest && event.target.closest(".theme-toggle")) {
      window.__toggleTheme();
    }
  });
})();
