// @ts-check
import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';
import '@agoric/governance/src/exported.js';
import {
  assertProposalShape,
  ceilMultiplyBy,
  floorDivideBy,
  floorMultiplyBy,
} from '@agoric/zoe/src/contractSupport/index.js';
import { Far } from '@endo/marshal';
import { handleParamGovernance, ParamTypes } from '@agoric/governance';

import { AmountMath } from '@agoric/ertp';
import { makeMakeCollectFeesInvitation } from '../collectFees.js';

const { details: X } = assert;

/**
 * @file The Parity Stability Module supports efficiently minting/burning a
 * stable token at a specified fixed ratio to a reference stable token, which
 * thereby acts as an anchor to provide additional stability. For flexible
 * economic policies, the fee percentage for trading into and out of the stable
 * token are specified separately.
 *
 */

/**
 * Stage a transfer of a single asset from one seat to another, with an optional
 * remapping of the Keywords. Check that the remapping is for the same amount.
 *
 * @param {ZCFSeat} from
 * @param {ZCFSeat} to
 * @param {AmountKeywordRecord} txFrom
 * @param {AmountKeywordRecord} txTo
 */
function stageTransfer(from, to, txFrom, txTo = txFrom) {
  assert(AmountMath.isEqual(Object.values(txFrom)[0], Object.values(txTo)[0]));
  from.decrementBy(txFrom);
  to.incrementBy(txTo);
}

/**
 * @param {ZCF<GovernanceTerms<{
 *    GiveStableFee: 'ratio',
 *    WantStableFee: 'ratio',
 *    MintLimit: 'amount',
 *   }> & {
 *    anchorBrand: Brand,
 *    anchorPerStable: Ratio,
 * }>} zcf
 * @param {{feeMintAccess: FeeMintAccess, initialPoserInvitation: Invitation, storageNode?: StorageNode, marshaller?: Marshaller}} privateArgs
 */
export const start = async (zcf, privateArgs) => {
  const { anchorBrand, anchorPerStable } = zcf.getTerms();

  // TODO should this know that the name is 'Stable'
  // TODO get the RUN magic out of here so the contract is more reusable
  const stableMint = await zcf.registerFeeMint(
    'Stable',
    privateArgs.feeMintAccess,
  );
  const { brand: stableBrand } = stableMint.getIssuerRecord();
  assert(
    anchorPerStable.numerator.brand === anchorBrand &&
      anchorPerStable.denominator.brand === stableBrand,
    X`Ratio ${anchorPerStable} is not consistent with brands ${anchorBrand} and ${stableBrand}`,
  );

  zcf.setTestJig(() => ({
    stableIssuerRecord: stableMint.getIssuerRecord(),
  }));
  const emptyStable = AmountMath.makeEmpty(stableBrand);
  const emptyAnchor = AmountMath.makeEmpty(anchorBrand);

  const { augmentPublicFacet, makeGovernorFacet, params } =
    await handleParamGovernance(
      zcf,
      privateArgs.initialPoserInvitation,
      {
        GiveStableFee: ParamTypes.RATIO,
        MintLimit: ParamTypes.AMOUNT,
        WantStableFee: ParamTypes.RATIO,
      },
      privateArgs.storageNode,
      privateArgs.marshaller,
    );

  const { zcfSeat: anchorPool } = zcf.makeEmptySeatKit();
  const { zcfSeat: feePool } = zcf.makeEmptySeatKit();
  const { zcfSeat: stage } = zcf.makeEmptySeatKit();

  /**
   * @param {Amount<'nat'>} given
   */
  const assertUnderLimit = given => {
    const anchorAfterTrade = AmountMath.add(
      anchorPool.getAmountAllocated('Anchor', anchorBrand),
      given,
    );
    assert(
      AmountMath.isGTE(params.getMintLimit(), anchorAfterTrade),
      X`Request would exceed mint limit`,
    );
  };

  /**
   * @param {ZCFSeat} seat
   * @param {Amount<'nat'>} given
   * @param {Amount<'nat'>} [wanted]
   */
  const giveStable = (seat, given, wanted = emptyAnchor) => {
    const fee = ceilMultiplyBy(given, params.getGiveStableFee());
    const afterFee = AmountMath.subtract(given, fee);
    const maxAnchor = floorMultiplyBy(afterFee, anchorPerStable);
    // TODO this prevents the reallocate from failing. Can this be tested otherwise?
    assert(
      AmountMath.isGTE(maxAnchor, wanted),
      X`wanted ${wanted} is more then ${given} minus fees ${fee}`,
    );
    stageTransfer(seat, stage, { In: afterFee }, { Stable: afterFee });
    stageTransfer(seat, feePool, { In: fee }, { Stable: fee });
    stageTransfer(anchorPool, seat, { Anchor: maxAnchor }, { Out: maxAnchor });
    zcf.reallocate(seat, anchorPool, stage, feePool);
    stableMint.burnLosses({ Stable: afterFee }, stage);
  };

  /**
   * @param {ZCFSeat} seat
   * @param {Amount<'nat'>} given
   * @param {Amount<'nat'>} [wanted]
   */
  const wantStable = (seat, given, wanted = emptyStable) => {
    assertUnderLimit(given);
    const asStable = floorDivideBy(given, anchorPerStable);
    const fee = ceilMultiplyBy(asStable, params.getWantStableFee());
    const afterFee = AmountMath.subtract(asStable, fee);
    assert(
      AmountMath.isGTE(afterFee, wanted),
      X`wanted ${wanted} is more then ${given} minus fees ${fee}`,
    );
    stableMint.mintGains({ Stable: asStable }, stage);
    stageTransfer(seat, anchorPool, { In: given }, { Anchor: given });
    stageTransfer(stage, seat, { Stable: afterFee }, { Out: afterFee });
    stageTransfer(stage, feePool, { Stable: fee });
    try {
      zcf.reallocate(seat, anchorPool, stage, feePool);
    } catch (e) {
      // NOTE someday, reallocate should guarantee that this case cannot happen
      stableMint.burnLosses({ Stable: asStable }, stage);
      throw e;
    }
  };

  /**
   * @param {ZCFSeat} seat
   */
  const swapHook = seat => {
    assertProposalShape(seat, {
      give: { In: null },
    });
    const {
      give: { In: given },
      want: { Out: wanted } = { Out: undefined },
    } = seat.getProposal();
    if (given.brand === stableBrand) {
      giveStable(seat, given, wanted);
    } else if (given.brand === anchorBrand) {
      wantStable(seat, given, wanted);
    } else {
      throw Error(`unexpected brand ${given.brand}`);
    }
    seat.exit();
  };
  const makeSwapInvitation = () => zcf.makeInvitation(swapHook, 'swap');

  const publicFacet = Far('Parity Stability Module', {
    getPoolBalance: () => anchorPool.getAmountAllocated('Anchor', anchorBrand),
    makeSwapInvitation,
  });

  const getRewardAllocation = () => feePool.getCurrentAllocation();
  const { makeCollectFeesInvitation } = makeMakeCollectFeesInvitation(
    zcf,
    feePool,
    stableBrand,
    'Stable',
  );
  const creatorFacet = Far('Parity Stability Module', {
    getRewardAllocation,
    makeCollectFeesInvitation,
  });

  return {
    creatorFacet: makeGovernorFacet(creatorFacet),
    publicFacet: augmentPublicFacet(publicFacet),
  };
};
