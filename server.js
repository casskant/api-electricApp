import app from "./src/app.js";
import "dotenv/config"


const PORT = process.env.PORT_API || 3000;

app.listen(PORT, () => {
  console.log(`API REST démarrée sur http://localhost:${PORT}`);
});
