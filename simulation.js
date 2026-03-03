require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express'); // ADDED THIS

// --- DUMMY WEB SERVER FOR RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('✅ SPTIS Live Simulation Engine is Running 24/7!');
});
app.listen(port, () => {
  console.log(`🌐 Dummy Web Server listening on port ${port}`);
});
// -----------------------------------

// Initialize Supabase with the MASTER Service Key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function startSimulation() {
  console.log("🚀 Starting SPTIS Fleet Simulation Engine...");

  // Fetch all 81 buses from your database to hold in memory
  let { data: buses, error } = await supabase.from('bus_telemetry').select('*');
  if (error) {
    console.error("❌ Database Connection Error:", error.message);
    return;
  }

  console.log(`✅ Loaded ${buses.length} buses. Simulation running...`);

  // Run the engine loop every 3 seconds
  setInterval(async () => {
    for (let i = 0; i < buses.length; i++) {
      let bus = buses[i];
      let stateChanged = false;

      if (bus.buffer_active) {
         bus.eta_seconds -= 3;
         if (bus.eta_seconds <= 0) {
            bus.buffer_active = false;
            
            // Passenger Math (Boarding/Alighting)
            const boarding = Math.floor(Math.random() * 8);
            const alighting = Math.floor(Math.random() * 6);
            bus.occupied_seats = Math.max(0, Math.min(65, bus.occupied_seats + boarding - alighting));
            
            // Move to next stop index
            bus.current_stop_index = bus.current_stop_index + 1; 
            bus.eta_seconds = 20; // Drive time to next stop
            stateChanged = true;
         }
      } else {
         bus.eta_seconds -= 3;
         if (bus.eta_seconds <= 0) {
            bus.buffer_active = true;
            bus.eta_seconds = 9; // Wait at stop for 9 seconds
            stateChanged = true;
         }
      }

      // Push updates to Supabase ONLY when the state shifts (saves bandwidth)
      if (stateChanged) {
        const { error: updateErr } = await supabase
          .from('bus_telemetry')
          .update({
            occupied_seats: bus.occupied_seats,
            current_stop_index: bus.current_stop_index,
            buffer_active: bus.buffer_active,
            eta_seconds: bus.eta_seconds
          })
          .eq('id', bus.id);
          
        if (updateErr) console.error(`Error updating bus ${bus.id}:`, updateErr.message);
      }
    }
  }, 3000); // 3-second loop
}

startSimulation();