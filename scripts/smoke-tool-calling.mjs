const response = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "qwen/qwen3.6-27b",
    messages: [{ role: "user", content: "Add 3 and 5" }],
    tools: [
      {
        type: "function",
        function: {
          name: "add_numbers",
          description: "Add two numbers together",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number", description: "First number" },
              b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
          },
        },
      },
    ],
  }),
});

const data = await response.json();
console.log("STATUS:", response.status);
console.log(JSON.stringify(data, null, 2));