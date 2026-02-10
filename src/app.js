import express from "express";
import cors from "cors";        
import mapRoutes from "./routes/tripRoute.js";

const app = express();


app.use(cors({
  origin: "http://localhost:3000",
  credentials: true
}));

app.use(express.json());
app.use("/api", mapRoutes);



export default app;