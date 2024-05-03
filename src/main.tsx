import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Actyx } from '@actyx/sdk'

const actyx = await Actyx.of({
  appId: 'com.example.plant-watering',
  displayName: 'Plant Watering',
  version: '0.0.1',
})

createRoot(document.getElementById('root')!).render(<App actyx={actyx}/>)
