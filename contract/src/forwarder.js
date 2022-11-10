// @ts-check
/**
 * 
 */
import { Far } from '@endo/marshal';
import { E } from '@endo/eventual-send';
import { fit, M, makeScalarMapStore } from '@agoric/store';
import { AmountMath } from '@agoric/ertp';
 
 
const privateArgsShape = harden({

  storageNode: M.eref(M.remotable('storageNode')),
  marshaller: M.eref(M.remotable('marshaller')),
});
 
 
 
 
/**
* 
* @type {ContractStartFn}
*/
const start = async (zcf, privateArgs) => {
 
  /* Initial (creatorFacet) code for the contract */
 
  // check validity of private args
  fit(privateArgs, privateArgsShape, 'IST Forwarder privateArgs');
 
  /** @type { MapStore<Brand, Instance> }  */
  const brandToPSM = makeScalarMapStore();

  /**
  * Creates a mapping of brand <> instance in the variable `brandToPSM`
  * 
  * @param {Brand<AssetKind>} brand An asset brand supported by the PSM
  * @param {Instance} instance The PSM contract instance for the supported brand
  */
  const initPSM = (brand, instance) => {
    fit(brand, M.remotable('brand'));
    fit(instance, M.remotable('instance'));
    brandToPSM.init(brand, instance);
  }
 
  /**
  * Supplementary method to initialize `brandToPSM` by an array
  * 
  * @param {[Brand<AssetKind>, Instance][]} arr A list of brands and their related PSM instances
  */
  const initMultiplePSM = (arr) => {
    arr.map( (item) => initPSM(item[0], item[1]) );
  }
 
 
  /* Exposed (publicFacet) code of the contract */
 
  const zoe = zcf.getZoeService();

  /**
   * This method interfaces with the PSM instance and returns a payment (of IST)
   * 
   * @param {*} paymentIn 
   * @param {*} amount 
   * @param {*} instance 
   * @returns 
   */
  const getPayOut = async (paymentIn, amount, instance) => {
    const proposal = harden({ give: { In: amount } });
    const psmPublic = E(zoe).getPublicFacet(instance);
    const invitation = E(psmPublic).makeSwapInvitation();
    const seat = E(zoe).offer(invitation, proposal, { In: paymentIn });
    const paymentOut = await E(seat).getPayout('Out');
    return paymentOut;
    // TODO metrics
  }

  /**
   * Deposits the `payment` in the wallet of `address`
   * 
   * @param {*} payment 
   * @param {*} address 
   */
  const depositPayment = (payment, address) => {
    // `home` may not be available to contract
    const depFacet = E(home.namesByAddress).lookup(address, 'depositFacet');
    depFacet.receive(payment);
  }

  /**
   * The exposed function. Checks for various things and calls helper functions.
   * 
   * @param {*} asset 
   * @param {*} destination 
   * @returns 
   */
  const swapAndSend = async (asset, destination) => {

    // check destination indeed exists
    // check asset is of the correct type
    const amount = asset.Value;

    if(!brandToPSM.has(asset)) {
      console.error(`No PSM instance for incoming asset: ${asset}`);
      return false;
    }
    const psmInstance = brandToPSM.get(asset);
    const paymentIn = undefined;

    const paymentOut = await getPayOut(paymentIn, amount, psmInstance);
    depositPayment(paymentOut, destination);

    return true;
  }
 
  /* Create public and creator facets, and harden */
 
  const publicFacet = Far('', { swapAndSend });

  // tie with governance?
  const creatorFacet = Far('', {
    initPSM,
    initMultiplePSM,
  });
 
  // @ts-ignore
  return harden({ creatorFacet, publicFacet });
}
 
// harden and export
harden(start);
export { start };