"use client";

/** Last-resort boundary: replaces the whole document, so it ships its own html/body. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          color: "#111111",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            Something went wrong.
          </h1>
          <p style={{ fontSize: 14, color: "#666666", margin: 0 }}>
            Please reload the page and try again.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 11, color: "#999999", marginTop: 12 }}>
              Reference {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
