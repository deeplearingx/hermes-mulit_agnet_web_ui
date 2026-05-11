let gatewayManager: any = null

export function getGatewayManagerInstance(): any {
  return gatewayManager
}

export async function initGatewayManager(): Promise<void> {
  // P6.5: Allow smoke tests to bypass GatewayManager so that UPSTREAM env var
  // is used as the fallback upstream (profile resolver returns constructor fallback).
  if (process.env.GATEWAY_MANAGER_DISABLED === '1') {
    console.log('[bootstrap] GatewayManager disabled (GATEWAY_MANAGER_DISABLED=1)')
    return
  }

  const { GatewayManager } = await import('./hermes/gateway-manager')
  const { getActiveProfileName } = await import('./hermes/hermes-profile')
  const activeProfile = getActiveProfileName()
  gatewayManager = new GatewayManager(activeProfile)

  await gatewayManager.detectAllOnStartup()
  await gatewayManager.startAll()
  console.log("startall")
}
