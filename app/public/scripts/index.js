async function load() {
  try {
    const info = await fetch("/api/info").then((r) => r.json());
    document.getElementById("info").textContent = JSON.stringify(info, null, 2);
  } catch (e) {
    document.getElementById("info").textContent = "error: " + e.message;
  }

  const dot = document.getElementById("db-dot");
  const text = document.getElementById("db-text");
  try {
    const res = await fetch("/api/db-status");
    const db = await res.json();
    if (db.db === "connected") {
      dot.className = "dot ok";
      text.textContent = "Connected";
    } else {
      dot.className = "dot err";
      text.textContent = db.db;
    }
    document.getElementById("db").textContent = JSON.stringify(db, null, 2);
  } catch (e) {
    dot.className = "dot err";
    text.textContent = "unreachable";
    document.getElementById("db").textContent = e.message;
  }
}

document.getElementById("refresh").addEventListener("click", load);
load();
