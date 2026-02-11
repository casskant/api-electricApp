import express from "express";
import cors from "cors";        
import mapRoutes from "./routes/tripRoute.js";
import "dotenv/config"

const app = express();


app.use(cors({
  origin: process.env.ORIGIN || "http://localhost:3000",
  credentials: true
}));

app.use(express.json());
app.use("/api", mapRoutes);



export default app;
