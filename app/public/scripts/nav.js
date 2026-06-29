/* Shared top navigation. Add a new module by appending to NAV_ITEMS — every page
   that includes this script picks it up automatically.

   Renders into <nav id="topnav" class="topnav"></nav> and marks the link (or
   group) matching the current URL as active. */
(function () {
  var NAV_ITEMS = [
    { type: "link", href: "/", label: "Home" },
    {
      type: "group",
      label: "Control Sections",
      prefix: "/control-sections",
      children: [
        { href: "/control-sections.html", label: "Manage" },
        { href: "/control-sections-upload.html", label: "Upload CSV" },
      ],
    },
    {
      type: "group",
      label: "Compliance",
      prefix: "/compliance",
      children: [
        { href: "/compliance-reports.html", label: "Reports" },
        { href: "/compliance-upload.html", label: "Upload report" },
      ],
    },
  ];

  // Normalize so "", "/index.html" and "/" all mean home.
  var path = location.pathname;
  if (path === "" || path === "/index.html") path = "/";
  var isActive = function (href) { return path === href; };

  var link = function (item) {
    return '<a href="' + item.href + '"' + (isActive(item.href) ? ' class="active"' : "") + ">" + item.label + "</a>";
  };

  var linksHtml = NAV_ITEMS
    .map(function (item) {
      if (item.type === "link") return link(item);
      // A group is active when the URL is under its prefix (covers detail pages).
      var childActive = item.prefix
        ? path.indexOf(item.prefix) === 0
        : item.children.some(function (c) { return isActive(c.href); });
      return (
        '<div class="group">' +
        '<button class="grouptrigger' + (childActive ? " active" : "") + '" type="button">' +
        item.label + " ▾</button>" +
        '<div class="dropdown">' + item.children.map(link).join("") + "</div>" +
        "</div>"
      );
    })
    .join("");

  var html =
    '<a class="brand" href="/">Qualys <span>Stack</span></a>' +
    '<div class="links">' + linksHtml + "</div>";

  var mount = function () {
    var el = document.getElementById("topnav");
    if (el) el.innerHTML = html;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
