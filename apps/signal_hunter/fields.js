'use strict';
// fields.js - written by kit/tools/gen_signal_hunter.js (do not edit): every status field Signal Hunter listens to,
// per interface, read only.
module.exports = {
 "de.bmw.body.DoorsWindowsRoofMirrors": [
  "CentralLockingSystemAndPanelStatus"
 ],
 "de.bmw.body.Light": [
  "StatusFunctionsIndicators"
 ],
 "de.bmw.body.steeringwheelcomfort.SteeringWheelClimate": [
  "heatingState"
 ],
 "de.bmw.chassis.SteeringAngle": [
  "ActualSteeringAngleDriver",
  "actualSteeringAngleDriverNoCRC"
 ],
 "de.bmw.chassis.VehicleModel": [
  "LaneSlope",
  "MassVehicle"
 ],
 "de.bmw.chassis.VehicleStabilizationManagement": [
  "StabilizationManagement"
 ],
 "de.bmw.infotainment.KombiIF": [
  "statusBordcomputerAverage",
  "statusBordcomputerTravelData",
  "statusDisplayElectricalPowerDistribution",
  "statusRangeTankStatus"
 ],
 "de.bmw.infotainment.KombiInterface_2": [
  "cbsDataSBA",
  "cbsDataServiceList",
  "ccList",
  "newCCMessage"
 ],
 "de.bmw.infotainment.checkcontrol.CheckControlMaster": [
  "basicList"
 ],
 "de.bmw.infotainment.climate.Climate": [
  "statusSeatHeatingDR",
  "statusSeatHeatingDRR",
  "statusSeatHeatingPS",
  "statusSeatHeatingPSR"
 ],
 "de.bmw.infotainment.climate.Climate2": [
  "statusACFront",
  "statusActualValuePowerACCompressor",
  "statusAirConditionDRStatus"
 ],
 "de.bmw.infotainment.climate.climatemaster.ClimateMaster": [
  "statusAirCondAC",
  "statusClimateSystemOn"
 ],
 "de.bmw.infotainment.connectivity.telephony.ConnectivityAggregator": [
  "aggregatedCallState"
 ],
 "de.bmw.infotainment.controlelements.FrontCCU": [
  "statusPushButtonsState",
  "statusRotaryEncoderState"
 ],
 "de.bmw.infotainment.drivingexcitement.Efficiencytainment": [
  "statusPowerRelativRecuperation"
 ],
 "de.bmw.infotainment.drivingexcitement.Efficiencytainment2": [
  "displayPowerDrive",
  "displayPowerDrive2",
  "statusBatteryTemperature",
  "statusChargeOfBatteryHybrid",
  "statusPowerRelativHybrid"
 ],
 "de.bmw.infotainment.drivingexcitement.FES": [
  "statusActualValueTorque2",
  "statusFESVehicleDynamicSwitchHMI",
  "statusSwitchDriveDynamicSport2",
  "statusVehicleDynamicEngine",
  "statusVehicleDynamicEngineMaxValue"
 ],
 "de.bmw.infotainment.lsc.LSCDataSink": [
  "statusHighVoltageStorage"
 ],
 "de.bmw.infotainment.misc.ComfortFunctionIuK": [
  "statusAmbientLightInteriorColour"
 ],
 "de.bmw.infotainment.misc.MDrive": [
  "dataDisplayGearbox",
  "statusMSystem"
 ],
 "de.bmw.infotainment.resetlogic.ResetLogic": [
  "averageConsumption",
  "currentConsumption"
 ],
 "de.bmw.infotainment.vehicle.CDS": [
  "datenFahrdynamiksensorErweitert",
  "statusBattery2",
  "statusEngineSpeed2",
  "statusEngineStatus",
  "statusEngineTemperature",
  "statusHandBrake"
 ],
 "de.bmw.infotainment.vehicle.CDS2": [
  "statusInjectionVolume",
  "statusLateralAccelerationMassCenter",
  "statusLongitudinalAccelerationMassCenter",
  "statusPushButtonMSA2",
  "statusYawVelocityVehicle"
 ],
 "de.bmw.infotainment.vehicle.TPMS": [
  "statusTargetTyrePressure",
  "statusTyrePressure",
  "statusTyreTemperature"
 ],
 "de.bmw.infotainment.vehicle.Vehicle": [
  "statusDayNightChangeOver",
  "statusNewCurrentUnitsStatusExt"
 ],
 "de.bmw.infotainment.vehicle.Vehicle2": [
  "highVoltageStorageInfoToExternal",
  "statusCarSpeed2",
  "statusLightStatus",
  "statusOilDipstick2",
  "statusVehicleMass",
  "statusVehiclePartType"
 ],
 "de.bmw.infrastructure.EnvironmentalInformation": [
  "ExteriorTemperature",
  "UnitBN2020"
 ],
 "de.bmw.infrastructure.VehicleCondition": [
  "VehicleCondition",
  "vehicleConditionNoCrc"
 ],
 "de.bmw.infrastructure.VehicleInformation": [
  "DataPowerTrain2",
  "Range",
  "statusGearboxDrive"
 ],
 "de.bmw.infrastructure.analytics.BasicDataSet": [
  "basicDataSet"
 ],
 "de.bmw.powertrain.AcceleratorPedal": [
  "AngleAcceleratorPedal"
 ],
 "de.bmw.powertrain.Powertrain": [
  "ActualValueRPMWheel"
 ]
};
