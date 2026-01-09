require('dotenv').config();
const app = require('./app'); // ajusta si tu archivo se llama distinto

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API de log-assistant escuchando en http://localhost:${PORT}`);
});
