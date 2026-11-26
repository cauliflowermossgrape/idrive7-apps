'use strict';
/**
 * demo.js - a made-up parked car for Signal Hunter's demo (no car, or Settings > Demo data): every 40 s a door opens
 * and shuts, the left indicator blinks, A/C goes on, the seat heating steps up, a button is pressed and Sport is
 * chosen, while a counter and the 12 V charge tick along as noise does. The interface and field names are real ones
 * the apps here read; the members inside them are invented for the demo and say nothing about a real car.
 */
const CYCLE = 40000;

/** The fields' values at time t (ms): [[key, value], ...], key "<interface>|<field>". */
function demoAt(t) {
    const p = (t % CYCLE) / 1000, cyc = Math.floor(t / CYCLE);
    const door = p >= 5 && p < 12 ? 'OPEN' : 'CLOSED';
    const blink = p >= 15 && p < 20 ? (Math.floor(p * 2) % 2 ? 'ON' : 'OFF') : 'OFF';
    return [
        ['de.bmw.body.DoorsWindowsRoofMirrors|CentralLockingSystemAndPanelStatus', { doorFrontLeft: door, doorFrontRight: 'CLOSED', tailgate: 'CLOSED', locked: false }],
        ['de.bmw.body.Light|StatusFunctionsIndicators', { left: blink, right: 'OFF', hazard: 'OFF' }],
        ['de.bmw.infotainment.climate.Climate2|statusACFront', { status: p >= 22 ? 'ON' : 'OFF' }],
        ['de.bmw.infotainment.climate.Climate|statusSeatHeatingDR', { level: p >= 26 ? (p >= 28 ? 2 : 1) : 0 }],
        ['de.bmw.infotainment.controlelements.FrontCCU|statusPushButtonsState', { button: p >= 30 && p < 30.6 ? 'PRESSED' : 'RELEASED', id: 7 }],
        ['de.bmw.infotainment.drivingexcitement.FES|statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: p >= 34 ? 'SPORT' : 'COMFORT' }],
        ['de.bmw.infotainment.vehicle.CDS|statusBattery2', { conditionBatteryChargingCondition: 80 + (Math.floor(t / 1700) % 2) }],
        ['de.bmw.infrastructure.VehicleCondition|VehicleCondition', { aliveCounter: Math.floor(t / 500) % 15, condition: 'PARKING' }],
        ['de.bmw.infrastructure.EnvironmentalInformation|ExteriorTemperature', { value: 23 + ((cyc % 3) === 2 && p > 36 ? 1 : 0) }],
        ['de.bmw.infotainment.vehicle.Vehicle2|statusCarSpeed2', { speedVehicleCentreOfGravity: 0 }],
    ];
}

module.exports = { demoAt, CYCLE };
